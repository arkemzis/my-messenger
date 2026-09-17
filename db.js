const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 
  'postgresql://postgres:Ya_Hochy_Svobodi@localhost:5432/mymessenger';

// RelaxDev требует ssl: false (внутренняя сеть, без TLS)
// Railway требует ssl: { rejectUnauthorized: false }
const isLocal = !process.env.DATABASE_URL;
const isRailway = process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway');

const pool = new Pool({
  connectionString: connectionString,
  ssl: isLocal ? false : (isRailway ? { rejectUnauthorized: false } : false),
});

module.exports = pool;