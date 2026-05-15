const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "Bsu2026!@", 
  database: "accounting_system",
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = pool;