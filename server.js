const express = require('express');
const path = require('path');
const app = express();
const PORT = 3000;

// Чтобы сервер понимал данные из формы (JSON и обычные формы)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Раздаём статические файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Временное хранилище пользователей (пока в памяти)
const users = [];

// Главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Регистрация
app.post('/register', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Заполните email и пароль' });
  }

  // Проверка: такой email уже есть?
  if (users.find(u => u.email === email)) {
    return res.status(409).json({ ok: false, message: 'Такой email уже зарегистрирован' });
  }

  // Сохраняем
  users.push({ email, password });
  console.log('Новый пользователь:', email);
  console.log('Всего пользователей:', users.length);

  res.json({ ok: true, message: 'Регистрация успешна!' });
});

// Вход
app.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Заполните email и пароль' });
  }

  const user = users.find(u => u.email === email && u.password === password);
  if (!user) {
    return res.status(401).json({ ok: false, message: 'Неверный email или пароль' });
  }

  res.json({ ok: true, message: 'Вход выполнен!' });
});

// Список всех пользователей (для отладки)
app.get('/users', (req, res) => {
  res.json(users);
});

app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});