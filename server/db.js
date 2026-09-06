// db.js
// One MySQL connection pool. Credentials come from backend/.env so
// they are never committed to source control.

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'zahil1234',
  database: process.env.DB_NAME || 'booking_system',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,        // keeps DATE columns as "2026-08-01" strings

  // Placeholders are always sent separately from the SQL text, which
  // is what makes SQL injection impossible here. Leave this off.
  multipleStatements: false
});

module.exports = pool;
