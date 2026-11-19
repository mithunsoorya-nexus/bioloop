const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const file = process.env.DB_FILE || path.join(__dirname, "data", "bioloop.db");
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new Database(file);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('restaurant','biogas','compost','farmer')),
  phone TEXT,
  demo INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS producers(
  id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  dist REAL NOT NULL,
  cap REAL NOT NULL,
  cats TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS listings(
  id TEXT PRIMARY KEY,
  rid TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rn TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('waste','surplus')),
  cat TEXT NOT NULL,
  kg REAL NOT NULL,
  loc TEXT NOT NULL,
  time_txt TEXT NOT NULL,
  when_iso TEXT,
  phone TEXT,
  photo TEXT,
  stage INTEGER NOT NULL DEFAULT 0,
  pid TEXT REFERENCES producers(id) ON DELETE SET NULL,
  recv REAL,
  demo INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_listings_rid ON listings(rid);
CREATE INDEX IF NOT EXISTS ix_listings_pid ON listings(pid);
CREATE TABLE IF NOT EXISTS compost(
  id TEXT PRIMARY KEY,
  pid TEXT NOT NULL REFERENCES producers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kg REAL NOT NULL,
  price REAL NOT NULL,
  doc INTEGER NOT NULL DEFAULT 0,
  demo INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS produce(
  id TEXT PRIMARY KEY,
  fid TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fn TEXT NOT NULL,
  crop TEXT NOT NULL,
  kg REAL NOT NULL,
  price REAL NOT NULL,
  harvest TEXT NOT NULL,
  loc TEXT NOT NULL,
  dist REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'Available',
  demo INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('C','Pr')),
  item TEXT NOT NULL,
  kg REAL NOT NULL,
  total REAL NOT NULL,
  buyer_name TEXT NOT NULL,
  buyer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Placed',
  created INTEGER NOT NULL
);
`);

// Unique, human-friendly ids like WP-48213
function newId(prefix, table) {
  const check = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
  for (let i = 0; i < 50; i++) {
    const id = prefix + (10000 + Math.floor(Math.random() * 90000));
    if (!check.get(id)) return id;
  }
  throw new Error("Could not allocate id");
}

module.exports = { db, newId, file };
