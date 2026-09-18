const express = require('express');
const path = require('path');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const pool = require('./db');

// Автоматическое создание таблиц при старте
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(100) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100) DEFAULT ''
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        from_user INTEGER NOT NULL,
        to_user INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Таблицы готовы');
  } catch (err) {
    console.error('Ошибка создания таблиц:', err.message);
  }
}
initDatabase();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'rocket-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// ===== HTTP + WebSocket =====
const server = http.createServer(app);
const io = new Server(server);

// Кто сейчас онлайн: { userId: [socketId1, socketId2, ...] }
const onlineUsers = new Map();

function getOnlineIds() {
  return Array.from(onlineUsers.keys());
}

// Главная
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Регистрация
app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Заполните email и пароль' });
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ ok: false, message: 'Такой email уже зарегистрирован' });
    }
    const result = await pool.query(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id',
      [email, password]
    );
    req.session.userId = result.rows[0].id;
    console.log('Новый пользователь:', email, 'id:', result.rows[0].id);
    res.json({ ok: true, message: 'Регистрация успешна!', userId: result.rows[0].id });
  } catch (err) {
    console.error('Ошибка базы:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Вход
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Заполните email и пароль' });
  }
  try {
    const result = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND password = $2',
      [email, password]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, message: 'Неверный email или пароль' });
    }
    req.session.userId = result.rows[0].id;
    res.json({ ok: true, message: 'Вход выполнен!', userId: result.rows[0].id });
  } catch (err) {
    console.error('Ошибка базы:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Установить имя
app.post('/set-name', async (req, res) => {
  const { userId, name } = req.body;
  const uid = parseInt(userId) || req.session.userId;
  if (!uid || !name || !name.trim()) {
    return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  }
  try {
    await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), uid]);
    res.json({ ok: true, message: 'Имя сохранено' });
  } catch (err) {
    console.error('Ошибка базы:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Выход
app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true, message: 'Вы вышли' });
});

// Кто я
app.get('/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ ok: false, message: 'Не вошёл' });
  }
  res.json({ ok: true, userId: req.session.userId });
});

// Список всех пользователей + кто онлайн
app.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, name FROM users ORDER BY id');
    const users = result.rows.map(u => ({
      ...u,
      online: onlineUsers.has(u.id)
    }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Получить сообщения
app.get('/messages', async (req, res) => {
  const withUserId = parseInt(req.query.with);
  const myId = parseInt(req.query.me) || req.session.userId;

  if (!myId || !withUserId) {
    return res.status(400).json({ ok: false, message: 'Не указан пользователь' });
  }

  try {
    const result = await pool.query(
      `SELECT id, from_user, to_user, text, created_at
       FROM messages
       WHERE (from_user = $1 AND to_user = $2)
          OR (from_user = $2 AND to_user = $1)
       ORDER BY id ASC`,
      [myId, withUserId]
    );
    res.json({ ok: true, messages: result.rows });
  } catch (err) {
    console.error('Ошибка базы:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Отправить сообщение
app.post('/send', async (req, res) => {
  const { to, text, from } = req.body;
  const fromUserId = parseInt(from) || req.session.userId;
  const toUserId = parseInt(to);

  if (!fromUserId || !toUserId || !text || !text.trim()) {
    return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO messages (from_user, to_user, text) VALUES ($1, $2, $3) RETURNING id, created_at',
      [fromUserId, toUserId, text.trim()]
    );

    io.emit('message', {
      id: result.rows[0].id,
      from: fromUserId,
      to: toUserId,
      text: text.trim(),
      created_at: result.rows[0].created_at
    });

    res.json({ ok: true, id: result.rows[0].id, created_at: result.rows[0].created_at });
  } catch (err) {
    console.error('Ошибка базы:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Удалить сообщение
app.delete('/messages/:id', async (req, res) => {
  const messageId = parseInt(req.params.id);
  const userId = parseInt(req.query.userId) || req.session.userId;

  if (!messageId || !userId) {
    return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  }

  try {
    const check = await pool.query(
      'SELECT from_user, to_user FROM messages WHERE id = $1',
      [messageId]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ ok: false, message: 'Сообщение не найдено' });
    }

    if (check.rows[0].from_user !== userId) {
      return res.status(403).json({ ok: false, message: 'Можно удалять только свои сообщения' });
    }

    await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);

    io.emit('message_deleted', {
      id: messageId,
      from: check.rows[0].from_user,
      to: check.rows[0].to_user
    });

    res.json({ ok: true, message: 'Сообщение удалено' });
  } catch (err) {
    console.error('Ошибка базы:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// ===== WebSocket =====
io.on('connection', (socket) => {
  console.log('WebSocket подключён:', socket.id);

  socket.on('identify', (userId) => {
    const uid = parseInt(userId);
    if (!uid) return;
    socket.userId = uid;
    socket.join('user_' + uid);

    // Отмечаем как онлайн
    if (!onlineUsers.has(uid)) {
      onlineUsers.set(uid, []);
    }
    onlineUsers.get(uid).push(socket.id);

    console.log('Пользователь', uid, 'подключён. Всего онлайн:', onlineUsers.size);

    // Рассылаем всем "пользователь онлайн"
    io.emit('user_online', { userId: uid });
    // Отправляем новому — список всех, кто сейчас онлайн
    socket.emit('online_list', getOnlineIds());
  });

  // "Печатает..."
  socket.on('typing', (data) => {
    if (!data || !data.to || !socket.userId) return;
    io.to('user_' + data.to).emit('user_typing', {
      from: socket.userId,
      typing: !!data.typing,
    });
  });

  socket.on('disconnect', () => {
    const uid = socket.userId;
    console.log('WebSocket отключён:', socket.id);

    if (uid && onlineUsers.has(uid)) {
      const arr = onlineUsers.get(uid).filter(id => id !== socket.id);
      if (arr.length === 0) {
        onlineUsers.delete(uid);
        io.emit('user_offline', { userId: uid });
      } else {
        onlineUsers.set(uid, arr);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});