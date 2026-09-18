const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const http = require('http');
const multer = require('multer');
const { Server } = require('socket.io');
const pool = require('./db');

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(100) DEFAULT '',
        avatar_url TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100) DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT ''`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        from_user INTEGER NOT NULL,
        to_user INTEGER,
        chat_id INTEGER,
        text TEXT NOT NULL DEFAULT '',
        image_url TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS chat_id INTEGER`);
    await pool.query(`ALTER TABLE messages ALTER COLUMN text SET DEFAULT ''`);
    await pool.query(`ALTER TABLE messages ALTER COLUMN to_user DROP NOT NULL`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_by INTEGER NOT NULL,
        is_channel BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_channel BOOLEAN DEFAULT FALSE`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_members (
        id SERIAL PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(chat_id, user_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS reactions (
        id SERIAL PRIMARY KEY,
        message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        emoji VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(message_id, user_id, emoji)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stories (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        image_url TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public_keys (
        user_id INTEGER PRIMARY KEY,
        public_key TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Таблицы готовы');
  } catch (err) {
    console.error('Ошибка создания таблиц:', err.message);
  }
}
initDatabase();

async function cleanupOldStories() {
  try {
    const result = await pool.query(
      "SELECT image_url FROM stories WHERE created_at < NOW() - INTERVAL '24 hours'"
    );
    for (const row of result.rows) {
      if (row.image_url && row.image_url.startsWith('/uploads/')) {
        const filename = row.image_url.replace('/uploads/', '');
        fs.unlink(path.join(__dirname, 'uploads', filename), () => {});
      }
    }
    await pool.query("DELETE FROM stories WHERE created_at < NOW() - INTERVAL '24 hours'");
  } catch (err) {}
}
setInterval(cleanupOldStories, 60 * 60 * 1000);

const app = express();
const PORT = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, Date.now() + '_' + Math.round(Math.random() * 1e9) + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use(session({
  secret: 'rocket-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

const server = http.createServer(app);
const io = new Server(server);

const onlineUsers = new Map();
function getOnlineIds() { return Array.from(onlineUsers.keys()); }

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, message: 'Заполните email и пароль' });
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(409).json({ ok: false, message: 'Такой email уже зарегистрирован' });
    const result = await pool.query(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id',
      [email, password]
    );
    req.session.userId = result.rows[0].id;
    res.json({ ok: true, message: 'Регистрация успешна!', userId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, message: 'Заполните email и пароль' });
  try {
    const result = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND password = $2',
      [email, password]
    );
    if (result.rows.length === 0) return res.status(401).json({ ok: false, message: 'Неверный email или пароль' });
    req.session.userId = result.rows[0].id;
    res.json({ ok: true, message: 'Вход выполнен!', userId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.post('/set-name', async (req, res) => {
  const { userId, name } = req.body;
  const uid = parseInt(userId) || req.session.userId;
  if (!uid || !name || !name.trim()) return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  try {
    await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), uid]);
    res.json({ ok: true, message: 'Имя сохранено' });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.post('/set-avatar', async (req, res) => {
  const { userId, avatarUrl } = req.body;
  const uid = parseInt(userId) || req.session.userId;
  if (!uid || !avatarUrl) return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  try {
    await pool.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, uid]);
    res.json({ ok: true, message: 'Аватарка сохранена' });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true, message: 'Вы вышли' });
});

app.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ ok: false, message: 'Не вошёл' });
  res.json({ ok: true, userId: req.session.userId });
});

app.get('/users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.email, u.name, u.avatar_url, pk.public_key
      FROM users u
      LEFT JOIN public_keys pk ON pk.user_id = u.id
      ORDER BY u.id
    `);
    const users = result.rows.map(u => ({ ...u, online: onlineUsers.has(u.id) }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Сохранить публичный ключ пользователя
app.post('/set-public-key', async (req, res) => {
  const { userId, publicKey } = req.body;
  const uid = parseInt(userId) || req.session.userId;
  if (!uid || !publicKey) {
    return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  }
  try {
    await pool.query(
      `INSERT INTO public_keys (user_id, public_key) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET public_key = $2`,
      [uid, publicKey]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка базы:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Получить публичный ключ пользователя
app.get('/public-key/:userId', async (req, res) => {
  const uid = parseInt(req.params.userId);
  if (!uid) return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  try {
    const result = await pool.query('SELECT public_key FROM public_keys WHERE user_id = $1', [uid]);
    if (result.rows.length === 0) {
      return res.json({ ok: true, publicKey: null });
    }
    res.json({ ok: true, publicKey: result.rows[0].public_key });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// ============ ГРУППЫ И КАНАЛЫ ============

// Создать группу или канал
app.post('/create-group', async (req, res) => {
  const { userId, name, memberIds, isChannel } = req.body;
  const uid = parseInt(userId) || req.session.userId;
  const isCh = isChannel === true;
  if (!uid || !name || !name.trim()) return res.status(400).json({ ok: false, message: 'Не хватает данных' });

  try {
    const chatResult = await pool.query(
      'INSERT INTO chats (name, created_by, is_channel) VALUES ($1, $2, $3) RETURNING id, name, is_channel, created_at',
      [name.trim(), uid, isCh]
    );
    const chatId = chatResult.rows[0].id;

    await pool.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [chatId, uid]);

    // В канал НЕ добавляем участников сразу — они подписываются сами
    if (!isCh && Array.isArray(memberIds)) {
      for (const mid of memberIds) {
        const m = parseInt(mid);
        if (m && m !== uid) {
          await pool.query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [chatId, m]);
        }
      }
    }

    res.json({ ok: true, chatId, name: chatResult.rows[0].name, isChannel: isCh });
  } catch (err) {
    console.error('Ошибка создания:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Мои группы и каналы
app.get('/my-chats', async (req, res) => {
  const uid = parseInt(req.query.userId) || req.session.userId;
  if (!uid) return res.status(400).json({ ok: false, message: 'Не хватает данных' });

  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.created_by, c.is_channel, c.created_at,
              (SELECT COUNT(*) FROM chat_members cm2 WHERE cm2.chat_id = c.id) AS members_count
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id
       WHERE cm.user_id = $1
       ORDER BY c.created_at DESC`,
      [uid]
    );
    res.json({ ok: true, chats: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Все публичные каналы (для поиска)
app.get('/all-channels', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.created_by, c.created_at,
              (SELECT COUNT(*) FROM chat_members cm WHERE cm.chat_id = c.id) AS members_count
       FROM chats c
       WHERE c.is_channel = TRUE
       ORDER BY c.created_at DESC`
    );
    res.json({ ok: true, channels: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Информация о чате (для определения админа)
app.get('/chat-info/:chatId', async (req, res) => {
  const chatId = parseInt(req.params.chatId);
  if (!chatId) return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  try {
    const result = await pool.query(
      'SELECT id, name, created_by, is_channel FROM chats WHERE id = $1',
      [chatId]
    );
    if (result.rows.length === 0) return res.status(404).json({ ok: false, message: 'Не найдено' });
    res.json({ ok: true, chat: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Участники
app.get('/chat-members/:chatId', async (req, res) => {
  const chatId = parseInt(req.params.chatId);
  if (!chatId) return res.status(400).json({ ok: false, message: 'Не хватает данных' });

  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.avatar_url
       FROM users u
       JOIN chat_members cm ON cm.user_id = u.id
       WHERE cm.chat_id = $1
       ORDER BY cm.joined_at ASC`,
      [chatId]
    );
    res.json({ ok: true, members: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Подписаться на канал
app.post('/join-channel', async (req, res) => {
  const { chatId, userId } = req.body;
  const cid = parseInt(chatId);
  const uid = parseInt(userId) || req.session.userId;
  if (!cid || !uid) return res.status(400).json({ ok: false, message: 'Не хватает данных' });

  try {
    await pool.query(
      'INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [cid, uid]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Добавить участника (только для групп)
app.post('/add-member', async (req, res) => {
  const { chatId, userId } = req.body;
  const cid = parseInt(chatId);
  const uid = parseInt(userId);
  if (!cid || !uid) return res.status(400).json({ ok: false, message: 'Не хватает данных' });

  try {
    const chatInfo = await pool.query('SELECT is_channel FROM chats WHERE id = $1', [cid]);
    if (chatInfo.rows[0]?.is_channel) {
      return res.status(400).json({ ok: false, message: 'В канал нельзя добавить — только подписка' });
    }

    await pool.query(
      'INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [cid, uid]
    );
    io.emit('chat_member_added', { chatId: cid, userId: uid });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// ============ СООБЩЕНИЯ ============

app.get('/messages', async (req, res) => {
  const myId = parseInt(req.query.me) || req.session.userId;
  const withUserId = parseInt(req.query.with);
  const chatId = parseInt(req.query.chatId);

  if (!myId) return res.status(400).json({ ok: false, message: 'Не вошёл' });

  try {
    let result;

    if (chatId) {
      result = await pool.query(
        `SELECT
           m.id, m.from_user, m.to_user, m.chat_id, m.text, m.image_url, m.created_at,
           u.name AS sender_name, u.email AS sender_email, u.avatar_url AS sender_avatar,
           COALESCE(
             (SELECT json_agg(json_build_object('user_id', r.user_id, 'emoji', r.emoji))
              FROM reactions r WHERE r.message_id = m.id),
             '[]'::json
           ) AS reactions
         FROM messages m
         LEFT JOIN users u ON u.id = m.from_user
         WHERE m.chat_id = $1
         ORDER BY m.id ASC`,
        [chatId]
      );
    } else if (withUserId) {
      result = await pool.query(
        `SELECT
           m.id, m.from_user, m.to_user, m.chat_id, m.text, m.image_url, m.created_at,
           COALESCE(
             (SELECT json_agg(json_build_object('user_id', r.user_id, 'emoji', r.emoji))
              FROM reactions r WHERE r.message_id = m.id),
             '[]'::json
           ) AS reactions
         FROM messages m
         WHERE m.chat_id IS NULL
           AND ((m.from_user = $1 AND m.to_user = $2)
             OR (m.from_user = $2 AND m.to_user = $1))
         ORDER BY m.id ASC`,
        [myId, withUserId]
      );
    } else {
      return res.status(400).json({ ok: false, message: 'Не указан чат' });
    }

    res.json({ ok: true, messages: result.rows });
  } catch (err) {
    console.error('Ошибка базы:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'Файл не загружен' });
  const imageUrl = '/uploads/' + req.file.filename;
  res.json({ ok: true, imageUrl });
});

app.post('/send', async (req, res) => {
  const { to, text, from, imageUrl, chatId } = req.body;
  const fromUserId = parseInt(from) || req.session.userId;
  const toUserId = parseInt(to);
  const cid = parseInt(chatId);
  const textTrim = (text || '').trim();
  const imgUrl = (imageUrl || '').trim();

  if (!fromUserId || (!textTrim && !imgUrl)) {
    return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  }

  // Группа или канал
  if (cid) {
    try {
      const chatInfo = await pool.query('SELECT is_channel, created_by FROM chats WHERE id = $1', [cid]);
      if (chatInfo.rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Чат не найден' });
      }
      const isChannel = chatInfo.rows[0].is_channel;
      const adminId = chatInfo.rows[0].created_by;

      // В канале — только админ может писать
      if (isChannel && fromUserId !== adminId) {
        return res.status(403).json({ ok: false, message: 'Только админ может писать в канал' });
      }

      const result = await pool.query(
        'INSERT INTO messages (from_user, chat_id, text, image_url) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
        [fromUserId, cid, textTrim, imgUrl]
      );

      const userRes = await pool.query('SELECT name, email, avatar_url FROM users WHERE id = $1', [fromUserId]);
      const sender = userRes.rows[0] || {};

      const membersRes = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [cid]);
      for (const row of membersRes.rows) {
        io.to('user_' + row.user_id).emit('message', {
          id: result.rows[0].id,
          from: fromUserId,
          chat_id: cid,
          text: textTrim,
          image_url: imgUrl,
          created_at: result.rows[0].created_at,
          sender_name: sender.name || sender.email,
          sender_email: sender.email,
          sender_avatar: sender.avatar_url || '',
          reactions: []
        });
      }

      return res.json({ ok: true, id: result.rows[0].id, created_at: result.rows[0].created_at });
    } catch (err) {
      console.error('Ошибка базы:', err.message);
      return res.status(500).json({ ok: false, message: 'Ошибка сервера' });
    }
  }

  // Личное сообщение
  if (!toUserId) return res.status(400).json({ ok: false, message: 'Не указан получатель' });

  try {
    const result = await pool.query(
      'INSERT INTO messages (from_user, to_user, text, image_url) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
      [fromUserId, toUserId, textTrim, imgUrl]
    );
    io.emit('message', {
      id: result.rows[0].id,
      from: fromUserId,
      to: toUserId,
      chat_id: null,
      text: textTrim,
      image_url: imgUrl,
      created_at: result.rows[0].created_at,
      reactions: []
    });
    res.json({ ok: true, id: result.rows[0].id, created_at: result.rows[0].created_at });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.delete('/messages/:id', async (req, res) => {
  const messageId = parseInt(req.params.id);
  const userId = parseInt(req.query.userId) || req.session.userId;
  if (!messageId || !userId) return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  try {
    const check = await pool.query('SELECT from_user, to_user, chat_id, image_url FROM messages WHERE id = $1', [messageId]);
    if (check.rows.length === 0) return res.status(404).json({ ok: false, message: 'Сообщение не найдено' });
    if (check.rows[0].from_user !== userId) return res.status(403).json({ ok: false, message: 'Можно удалять только свои' });

    const imgUrl = check.rows[0].image_url;
    if (imgUrl && imgUrl.startsWith('/uploads/')) {
      const filename = imgUrl.replace('/uploads/', '');
      fs.unlink(path.join(uploadsDir, filename), () => {});
    }

    await pool.query('DELETE FROM reactions WHERE message_id = $1', [messageId]);
    await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);

    if (check.rows[0].chat_id) {
      const membersRes = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [check.rows[0].chat_id]);
      for (const row of membersRes.rows) {
        io.to('user_' + row.user_id).emit('message_deleted', { id: messageId });
      }
    } else {
      io.emit('message_deleted', {
        id: messageId,
        from: check.rows[0].from_user,
        to: check.rows[0].to_user
      });
    }

    res.json({ ok: true, message: 'Сообщение удалено' });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.post('/react', async (req, res) => {
  const { messageId, userId, emoji } = req.body;
  const uid = parseInt(userId) || req.session.userId;
  const mid = parseInt(messageId);
  if (!mid || !uid || !emoji) return res.status(400).json({ ok: false, message: 'Не хватает данных' });

  try {
    const existing = await pool.query(
      'SELECT id FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [mid, uid, emoji]
    );

    let action;
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM reactions WHERE id = $1', [existing.rows[0].id]);
      action = 'removed';
    } else {
      await pool.query(
        'INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
        [mid, uid, emoji]
      );
      action = 'added';
    }

    const msg = await pool.query('SELECT from_user, to_user, chat_id FROM messages WHERE id = $1', [mid]);
    if (msg.rows.length > 0) {
      const payload = { messageId: mid, userId: uid, emoji, action };
      if (msg.rows[0].chat_id) {
        const membersRes = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [msg.rows[0].chat_id]);
        for (const row of membersRes.rows) {
          io.to('user_' + row.user_id).emit('reaction_update', payload);
        }
      } else {
        io.emit('reaction_update', payload);
      }
    }
    res.json({ ok: true, action });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// ============ СТОРИС ============
app.get('/stories', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.user_id, s.image_url, s.created_at,
             u.name, u.email, u.avatar_url
      FROM stories s
      JOIN users u ON u.id = s.user_id
      WHERE s.created_at > NOW() - INTERVAL '24 hours'
      ORDER BY s.created_at ASC
    `);
    res.json({ ok: true, stories: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.post('/add-story', async (req, res) => {
  const { userId, imageUrl } = req.body;
  const uid = parseInt(userId) || req.session.userId;
  if (!uid || !imageUrl) return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  try {
    const result = await pool.query(
      'INSERT INTO stories (user_id, image_url) VALUES ($1, $2) RETURNING id, created_at',
      [uid, imageUrl]
    );
    io.emit('story_added', { id: result.rows[0].id, user_id: uid, image_url: imageUrl, created_at: result.rows[0].created_at });
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.delete('/stories/:id', async (req, res) => {
  const storyId = parseInt(req.params.id);
  const userId = parseInt(req.query.userId) || req.session.userId;
  if (!storyId || !userId) return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  try {
    const check = await pool.query('SELECT user_id, image_url FROM stories WHERE id = $1', [storyId]);
    if (check.rows.length === 0) return res.status(404).json({ ok: false, message: 'Не найдено' });
    if (check.rows[0].user_id !== userId) return res.status(403).json({ ok: false, message: 'Не твоя сторис' });

    const imgUrl = check.rows[0].image_url;
    if (imgUrl && imgUrl.startsWith('/uploads/')) {
      const filename = imgUrl.replace('/uploads/', '');
      fs.unlink(path.join(uploadsDir, filename), () => {});
    }

    await pool.query('DELETE FROM stories WHERE id = $1', [storyId]);
    io.emit('story_deleted', { id: storyId, user_id: userId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// ============ WebSocket ============
io.on('connection', (socket) => {
  socket.on('identify', (userId) => {
    const uid = parseInt(userId);
    if (!uid) return;
    socket.userId = uid;
    socket.join('user_' + uid);
    if (!onlineUsers.has(uid)) onlineUsers.set(uid, []);
    onlineUsers.get(uid).push(socket.id);
    io.emit('user_online', { userId: uid });
    socket.emit('online_list', getOnlineIds());
  });

  socket.on('typing', (data) => {
    if (!data || !socket.userId) return;
    if (data.chatId) {
      pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [data.chatId])
        .then(result => {
          for (const row of result.rows) {
            if (row.user_id !== socket.userId) {
              io.to('user_' + row.user_id).emit('user_typing', {
                chatId: data.chatId,
                from: socket.userId,
                typing: !!data.typing,
              });
            }
          }
        })
        .catch(() => {});
    } else if (data.to) {
      io.to('user_' + data.to).emit('user_typing', {
        from: socket.userId,
        typing: !!data.typing,
      });
    }
  });

  socket.on('disconnect', () => {
    const uid = socket.userId;
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