const { Pool } = require('pg');

// Railway автоматически подставит DATABASE_URL в облаке.
// Локально — используем свои данные.
const connectionString = process.env.DATABASE_URL || 
  'postgresql://postgres:Ya_Hochy_Svobodi@localhost:5432/mymessenger';

const pool = new Pool({
  connectionString: connectionString,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

module.exports = pool;