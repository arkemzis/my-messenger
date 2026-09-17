const express = require('express');
const path = require('path');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const pool = require('./db');

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

// Список всех пользователей
app.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email FROM users ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Получить сообщения с пользователем
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

// HTTP-сервер + WebSocket
const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
  console.log('WebSocket подключён:', socket.id);

  socket.on('identify', (userId) => {
    socket.userId = userId;
    socket.join('user_' + userId);
    console.log('Пользователь', userId, 'подключён к WebSocket');
  });

  socket.on('disconnect', () => {
    console.log('WebSocket отключён:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});