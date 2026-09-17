const express = require('express');
const path = require('path');
const pool = require('./db');
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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

    await pool.query(
      'INSERT INTO users (email, password) VALUES ($1, $2)',
      [email, password]
    );

    console.log('Новый пользователь:', email);
    res.json({ ok: true, message: 'Регистрация успешна!' });
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

    res.json({ ok: true, message: 'Вход выполнен!' });
  } catch (err) {
    console.error('Ошибка базы:', err.message);
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

// Просмотр всех пользователей
app.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email FROM users ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Ошибка сервера' });
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});