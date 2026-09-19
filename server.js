const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const http = require('http');
const multer = require('multer');
const { Server } = require('socket.io');
const pool = require('./db');

// ============ FIREBASE ADMIN ============
let firebaseAdmin = null;
try {
  const admin = require('firebase-admin');
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseAdmin = admin;
    console.log('✅ Firebase Admin инициализирован');
  } else {
    console.log('⚠️ FIREBASE_SERVICE_ACCOUNT не задан — push-уведомления отключены');
  }
} catch (err) {
  console.error('Ошибка Firebase Admin:', err.message);
}

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
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT DEFAULT ''`);

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
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMP`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_url TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_name TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_size BIGINT DEFAULT 0`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_type TEXT DEFAULT ''`);
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hidden_chats (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        peer_id INTEGER NOT NULL,
        hidden_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, peer_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hidden_chat_groups (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        hidden_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, chat_id)
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
const uploadFile = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

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
  const myId = parseInt(req.query.me) || req.session.userId || 0;
  try {
    const result = await pool.query(`
      SELECT u.id, u.email, u.name, u.avatar_url, pk.public_key,
             hc.hidden_at,
             (SELECT COUNT(*) FROM messages m
              WHERE m.chat_id IS NULL
                AND m.from_user = u.id
                AND m.to_user = $1
                AND m.read_at IS NULL) AS unread_count
      FROM users u
      LEFT JOIN public_keys pk ON pk.user_id = u.id
      LEFT JOIN hidden_chats hc ON hc.user_id = $1 AND hc.peer_id = u.id
      ORDER BY u.id
    `, [myId]);
    const users = result.rows.map(u => ({ ...u, online: onlineUsers.has(u.id) }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

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


// Сохранить FCM-токен пользователя (для push-уведомлений)
app.post('/set-fcm-token', async (req, res) => {
  const { userId, fcmToken } = req.body;
  const uid = parseInt(userId) || req.session.userId;
  if (!uid || !fcmToken) {
    return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  }
  try {
    await pool.query('UPDATE users SET fcm_token = $1 WHERE id = $2', [fcmToken, uid]);
    res.json({ ok: true });
  } catch (err) {
    console.error('set-fcm-token error:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// ============ ГРУППЫ И КАНАЛЫ ============

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

app.get('/my-chats', async (req, res) => {
  const uid = parseInt(req.query.userId) || req.session.userId;
  if (!uid) return res.status(400).json({ ok: false, message: 'Не хватает данных' });

  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.created_by, c.is_channel, c.created_at,
              (SELECT COUNT(*) FROM chat_members cm2 WHERE cm2.chat_id = c.id) AS members_count,
              (SELECT COUNT(*) FROM messages m
               WHERE m.chat_id = c.id
                 AND m.from_user != $1
                 AND m.read_at IS NULL) AS unread_count,
              (SELECT hidden_at FROM hidden_chat_groups hcg
               WHERE hcg.user_id = $1 AND hcg.chat_id = c.id) AS hidden_at
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
           m.edited, m.reply_to_id, m.read_at,
           m.file_url, m.file_name, m.file_size, m.file_type,
           u.name AS sender_name, u.email AS sender_email, u.avatar_url AS sender_avatar,
           rm.text AS reply_text, rm.image_url AS reply_image_url, rm.from_user AS reply_from_user,
           rm.file_url AS reply_file_url, rm.file_name AS reply_file_name,
           ru.name AS reply_sender_name, ru.email AS reply_sender_email,
           COALESCE(
             (SELECT json_agg(json_build_object('user_id', r.user_id, 'emoji', r.emoji))
              FROM reactions r WHERE r.message_id = m.id),
             '[]'::json
           ) AS reactions
         FROM messages m
         LEFT JOIN users u ON u.id = m.from_user
         LEFT JOIN messages rm ON rm.id = m.reply_to_id
         LEFT JOIN users ru ON ru.id = rm.from_user
         WHERE m.chat_id = $1
         ORDER BY m.id ASC`,
        [chatId]
      );
    } else if (withUserId) {
      result = await pool.query(
        `SELECT
           m.id, m.from_user, m.to_user, m.chat_id, m.text, m.image_url, m.created_at,
           m.edited, m.reply_to_id, m.read_at,
           m.file_url, m.file_name, m.file_size, m.file_type,
           rm.text AS reply_text, rm.image_url AS reply_image_url, rm.from_user AS reply_from_user,
           rm.file_url AS reply_file_url, rm.file_name AS reply_file_name,
           ru.name AS reply_sender_name, ru.email AS reply_sender_email,
           COALESCE(
             (SELECT json_agg(json_build_object('user_id', r.user_id, 'emoji', r.emoji))
              FROM reactions r WHERE r.message_id = m.id),
             '[]'::json
           ) AS reactions
         FROM messages m
         LEFT JOIN messages rm ON rm.id = m.reply_to_id
         LEFT JOIN users ru ON ru.id = rm.from_user
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

app.post('/upload-file', uploadFile.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'Файл не загружен' });
  const fileUrl = '/uploads/' + req.file.filename;
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  res.json({
    ok: true,
    fileUrl,
    fileName: originalName,
    fileSize: req.file.size,
    fileType: req.file.mimetype,
  });
});

// Вспомогательная функция: получить инфо об оригинале (для цитаты)
async function getReplyInfo(replyId) {
  if (!replyId) return {};
  try {
    const r = await pool.query(
      `SELECT m.text, m.image_url, m.from_user, m.file_url, m.file_name,
              u.name, u.email
       FROM messages m
       LEFT JOIN users u ON u.id = m.from_user
       WHERE m.id = $1`,
      [replyId]
    );
    if (r.rows.length === 0) return { reply_to_id: null };
    return {
      reply_to_id: replyId,
      reply_text: r.rows[0].text,
      reply_image_url: r.rows[0].image_url,
      reply_file_url: r.rows[0].file_url,
      reply_file_name: r.rows[0].file_name,
      reply_from_user: r.rows[0].from_user,
      reply_sender_name: r.rows[0].name || r.rows[0].email,
      reply_sender_email: r.rows[0].email,
    };
  } catch (e) {
    return {};
  }
}

// ============ PUSH-УВЕДОМЛЕНИЯ ============
async function sendPushToUser(userId, title, body, data = {}) {
  if (!firebaseAdmin) return;
  try {
    const result = await pool.query('SELECT fcm_token FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) return;
    const token = result.rows[0].fcm_token;
    if (!token) return;

    await firebaseAdmin.messaging().send({
      token: token,
      notification: {
        title: title,
        body: body,
      },
      data: data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'arkzis_messages',
          sound: 'default',
        },
      },
    });
  } catch (err) {
    console.error('Push error:', err.message);
  }
}


app.post('/send', async (req, res) => {
  const { to, text, from, imageUrl, chatId, replyToId,
          fileUrl, fileName, fileSize, fileType } = req.body;
  const fromUserId = parseInt(from) || req.session.userId;
  const toUserId = parseInt(to);
  const cid = parseInt(chatId);
  const replyId = parseInt(replyToId) || null;
  const textTrim = (text || '').trim();
  const imgUrl = (imageUrl || '').trim();
  const fUrl = (fileUrl || '').trim();
  const fName = (fileName || '').trim();
  const fSize = parseInt(fileSize) || 0;
  const fType = (fileType || '').trim();

  if (!fromUserId || (!textTrim && !imgUrl && !fUrl)) {
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

      if (isChannel && fromUserId !== adminId) {
        return res.status(403).json({ ok: false, message: 'Только админ может писать в канал' });
      }

      const result = await pool.query(
        `INSERT INTO messages
           (from_user, chat_id, text, image_url, reply_to_id, file_url, file_name, file_size, file_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, created_at`,
        [fromUserId, cid, textTrim, imgUrl, replyId, fUrl, fName, fSize, fType]
      );

      const userRes = await pool.query('SELECT name, email, avatar_url FROM users WHERE id = $1', [fromUserId]);
      const sender = userRes.rows[0] || {};

      const replyInfo = await getReplyInfo(replyId);

      const membersRes = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [cid]);
      for (const row of membersRes.rows) {
        io.to('user_' + row.user_id).emit('message', {
          id: result.rows[0].id,
          from: fromUserId,
          chat_id: cid,
          text: textTrim,
          image_url: imgUrl,
          file_url: fUrl,
          file_name: fName,
          file_size: fSize,
          file_type: fType,
          created_at: result.rows[0].created_at,
          edited: false,
          read_at: null,
          sender_name: sender.name || sender.email,
          sender_email: sender.email,
          sender_avatar: sender.avatar_url || '',
          reactions: [],
          ...replyInfo,
        });
      }


      // Push всем участникам кроме отправителя
      try {
        const chatNameRes = await pool.query('SELECT name FROM chats WHERE id = $1', [cid]);
        const chatName = chatNameRes.rows[0]?.name || 'Чат';
        const senderName = sender.name || sender.email || 'Кто-то';
        let preview = textTrim;
        if (preview.startsWith('E2EE:')) preview = '🔒 Зашифрованное сообщение';
        if (!preview && imgUrl) preview = '📷 Фото';
        if (!preview && fUrl) preview = '📎 Файл';
        const pushTitle = chatName;
        const pushBody = senderName + ': ' + preview;
        for (const row of membersRes.rows) {
          if (row.user_id !== fromUserId) {
            sendPushToUser(
              row.user_id,
              pushTitle,
              pushBody,
              { type: 'message', chatId: cid.toString() }
            );
          }
        }
      } catch (e) {}

      return res.json({
        ok: true,
        id: result.rows[0].id,
        created_at: result.rows[0].created_at,
        read_at: null,
        ...replyInfo,
      });
    } catch (err) {
      console.error('Ошибка базы:', err.message);
      return res.status(500).json({ ok: false, message: 'Ошибка сервера' });
    }
  }

  // Личное сообщение
  if (!toUserId) return res.status(400).json({ ok: false, message: 'Не указан получатель' });

  try {
    const result = await pool.query(
      `INSERT INTO messages
         (from_user, to_user, text, image_url, reply_to_id, file_url, file_name, file_size, file_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, created_at`,
      [fromUserId, toUserId, textTrim, imgUrl, replyId, fUrl, fName, fSize, fType]
    );

    const replyInfo = await getReplyInfo(replyId);

    io.emit('message', {
      id: result.rows[0].id,
      from: fromUserId,
      to: toUserId,
      chat_id: null,
      text: textTrim,
      image_url: imgUrl,
      file_url: fUrl,
      file_name: fName,
      file_size: fSize,
      file_type: fType,
      created_at: result.rows[0].created_at,
      edited: false,
      read_at: null,
      reactions: [],
      ...replyInfo,
    });

    // Push получателю
    try {
      const senderRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [fromUserId]);
      const sender = senderRes.rows[0] || {};
      const senderName = sender.name || sender.email || 'Кто-то';
      let preview = textTrim;
      if (preview.startsWith('E2EE:')) preview = '🔒 Зашифрованное сообщение';
      if (!preview && imgUrl) preview = '📷 Фото';
      if (!preview && fUrl) preview = '📎 Файл';
      sendPushToUser(
        toUserId,
        senderName,
        preview,
        { type: 'message', peerId: fromUserId.toString() }
      );
    } catch (e) {}

    res.json({
      ok: true,
      id: result.rows[0].id,
      created_at: result.rows[0].created_at,
      read_at: null,
      ...replyInfo,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Пометить сообщения прочитанными
app.post('/mark-read', async (req, res) => {
  const { userId, withUserId, chatId } = req.body;
  const uid = parseInt(userId) || req.session.userId;
  const peerId = parseInt(withUserId);
  const cid = parseInt(chatId);

  if (!uid || (!peerId && !cid)) {
    return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  }

  try {
    if (cid) {
      await pool.query(
        `UPDATE messages SET read_at = NOW()
         WHERE chat_id = $1 AND from_user != $2 AND read_at IS NULL`,
        [cid, uid]
      );

      const membersRes = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [cid]);
      for (const row of membersRes.rows) {
        io.to('user_' + row.user_id).emit('messages_read', { chatId: cid, by: uid });
      }
    } else if (peerId) {
      await pool.query(
        `UPDATE messages SET read_at = NOW()
         WHERE chat_id IS NULL AND from_user = $1 AND to_user = $2 AND read_at IS NULL`,
        [peerId, uid]
      );

      io.to('user_' + peerId).emit('messages_read', { withUserId: uid, by: uid });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('mark-read error:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Редактировать сообщение
app.post('/edit-message', async (req, res) => {
  const { messageId, userId, newText } = req.body;
  const uid = parseInt(userId) || req.session.userId;
  const mid = parseInt(messageId);
  if (!mid || !uid || !newText || !newText.trim()) {
    return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  }

  try {
    const check = await pool.query(
      'SELECT from_user, chat_id, to_user FROM messages WHERE id = $1',
      [mid]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ ok: false, message: 'Сообщение не найдено' });
    }
    if (check.rows[0].from_user !== uid) {
      return res.status(403).json({ ok: false, message: 'Редактировать можно только свои' });
    }

    await pool.query(
      'UPDATE messages SET text = $1, edited = TRUE WHERE id = $2',
      [newText.trim(), mid]
    );

    const chatId = check.rows[0].chat_id;
    const toUser = check.rows[0].to_user;
    const payload = { id: mid, newText: newText.trim(), from: uid, edited: true };

    if (chatId) {
      const membersRes = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
      for (const row of membersRes.rows) {
        io.to('user_' + row.user_id).emit('message_edited', payload);
      }
    } else {
      io.to('user_' + toUser).emit('message_edited', payload);
      io.to('user_' + uid).emit('message_edited', payload);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка базы:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.delete('/messages/:id', async (req, res) => {
  const messageId = parseInt(req.params.id);
  const userId = parseInt(req.query.userId) || req.session.userId;
  if (!messageId || !userId) return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  try {
    const check = await pool.query(
      'SELECT from_user, to_user, chat_id, image_url, file_url FROM messages WHERE id = $1',
      [messageId]
    );
    if (check.rows.length === 0) return res.status(404).json({ ok: false, message: 'Сообщение не найдено' });
    if (check.rows[0].from_user !== userId) return res.status(403).json({ ok: false, message: 'Можно удалять только свои' });

    const imgUrl = check.rows[0].image_url;
    if (imgUrl && imgUrl.startsWith('/uploads/')) {
      const filename = imgUrl.replace('/uploads/', '');
      fs.unlink(path.join(uploadsDir, filename), () => {});
    }
    const fUrl = check.rows[0].file_url;
    if (fUrl && fUrl.startsWith('/uploads/')) {
      const filename = fUrl.replace('/uploads/', '');
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

// ============ СКРЫТИЕ / УДАЛЕНИЕ ЧАТОВ ============

app.post('/hide-chat', async (req, res) => {
  const { userId, peerId, chatId } = req.body;
  const uid = parseInt(userId) || req.session.userId;
  const peer = parseInt(peerId);
  const cid = parseInt(chatId);

  if (!uid || (!peer && !cid)) {
    return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  }

  try {
    if (cid) {
      await pool.query(
        `INSERT INTO hidden_chat_groups (user_id, chat_id, hidden_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id, chat_id) DO UPDATE SET hidden_at = NOW()`,
        [uid, cid]
      );
    } else {
      await pool.query(
        `INSERT INTO hidden_chats (user_id, peer_id, hidden_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id, peer_id) DO UPDATE SET hidden_at = NOW()`,
        [uid, peer]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('hide-chat error:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.post('/delete-chat-for-all', async (req, res) => {
  const { userId, peerId, chatId } = req.body;
  const uid = parseInt(userId) || req.session.userId;
  const peer = parseInt(peerId);
  const cid = parseInt(chatId);

  if (!uid || (!peer && !cid)) {
    return res.status(400).json({ ok: false, message: 'Не хватает данных' });
  }

  try {
    if (cid) {
      const chatInfo = await pool.query('SELECT created_by FROM chats WHERE id = $1', [cid]);
      if (chatInfo.rows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Чат не найден' });
      }
      if (chatInfo.rows[0].created_by !== uid) {
        return res.status(403).json({ ok: false, message: 'Только админ может удалить для всех' });
      }

      const imagesRes = await pool.query(
        `SELECT image_url, file_url FROM messages WHERE chat_id = $1`,
        [cid]
      );
      for (const row of imagesRes.rows) {
        if (row.image_url && row.image_url.startsWith('/uploads/')) {
          fs.unlink(path.join(uploadsDir, row.image_url.replace('/uploads/', '')), () => {});
        }
        if (row.file_url && row.file_url.startsWith('/uploads/')) {
          fs.unlink(path.join(uploadsDir, row.file_url.replace('/uploads/', '')), () => {});
        }
      }
      await pool.query('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = $1)', [cid]);
      await pool.query('DELETE FROM messages WHERE chat_id = $1', [cid]);

      const membersRes = await pool.query('SELECT user_id FROM chat_members WHERE chat_id = $1', [cid]);
      for (const row of membersRes.rows) {
        io.to('user_' + row.user_id).emit('chat_deleted', { chatId: cid, forAll: true });
      }

      return res.json({ ok: true });
    }

    const imagesRes = await pool.query(
      `SELECT image_url, file_url FROM messages
       WHERE chat_id IS NULL
         AND ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))`,
      [uid, peer]
    );
    for (const row of imagesRes.rows) {
      if (row.image_url && row.image_url.startsWith('/uploads/')) {
        fs.unlink(path.join(uploadsDir, row.image_url.replace('/uploads/', '')), () => {});
      }
      if (row.file_url && row.file_url.startsWith('/uploads/')) {
        fs.unlink(path.join(uploadsDir, row.file_url.replace('/uploads/', '')), () => {});
      }
    }
    await pool.query(
      `DELETE FROM reactions WHERE message_id IN (
         SELECT id FROM messages
         WHERE chat_id IS NULL
           AND ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))
       )`,
      [uid, peer]
    );
    await pool.query(
      `DELETE FROM messages
       WHERE chat_id IS NULL
         AND ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))`,
      [uid, peer]
    );

    io.to('user_' + peer).emit('chat_deleted', { peerId: uid, forAll: true });
    io.to('user_' + uid).emit('chat_deleted', { peerId: peer, forAll: true });

    res.json({ ok: true });
  } catch (err) {
    console.error('delete-chat-for-all error:', err.message);
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