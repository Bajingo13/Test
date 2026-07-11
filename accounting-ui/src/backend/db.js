const mysql = require("mysql2/promise");
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

function buildPoolConfig() {
  const database = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE;

  if (process.env.MYSQL_URL) {
    const url = new URL(process.env.MYSQL_URL);

    return {
      host: url.hostname,
      port: url.port || 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: database || url.pathname.replace(/^\//, "") || undefined,
      waitForConnections: true,
      connectionLimit: 10,
    };
  }

  return {
    host: process.env.MYSQLHOST || process.env.MYSQL_HOST,
    port: process.env.MYSQLPORT || process.env.MYSQL_PORT,
    user: process.env.MYSQLUSER || process.env.MYSQL_USER,
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD,
    database,
    waitForConnections: true,
    connectionLimit: 10,
  };
}

const pool = mysql.createPool(buildPoolConfig());

module.exports = pool;