const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'mymessenger',
  password: 'Ya_Hochy_Svobodi',
  port: 5432,
});

module.exports = pool;