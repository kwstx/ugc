const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new DatabaseSync(dbPath);

// Enable WAL mode & foreign keys for performance and integrity
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS creators (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    handle TEXT,
    avatar TEXT,
    status TEXT DEFAULT 'active',
    rate REAL DEFAULT 30.00,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS briefs (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    brand_name TEXT,
    about_brand TEXT,
    filming_instructions TEXT,
    qty INTEGER DEFAULT 6,
    rate REAL DEFAULT 30.00,
    total REAL DEFAULT 180.00,
    per_creator INTEGER DEFAULT 3,
    selected_creators TEXT, -- JSON array
    concepts TEXT,          -- JSON array
    status TEXT DEFAULT 'draft',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    brief_id TEXT,
    session_id TEXT,
    status TEXT DEFAULT 'pending',
    brand_name TEXT,
    qty INTEGER NOT NULL,
    rate REAL NOT NULL,
    total REAL NOT NULL,
    per_creator INTEGER NOT NULL,
    selected_creators TEXT,
    concepts TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(brief_id) REFERENCES briefs(id)
  );

  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mimetype TEXT,
    size INTEGER,
    url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS usage_metrics (
    year_month TEXT PRIMARY KEY,
    class_a_ops INTEGER DEFAULT 0,
    class_b_ops INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default creators if empty
const countStmt = db.prepare('SELECT COUNT(*) as count FROM creators');
const creatorCount = countStmt.get().count;

if (creatorCount === 0) {
  const insertCreator = db.prepare(`
    INSERT INTO creators (id, name, handle, avatar, status, rate)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const initialCreators = [
    ['creator_1', 'Sofia', '@sofia.ugc', 'avatar_1.png', 'active', 30.00],
    ['creator_2', 'Maya', '@maya_creates', 'avatar_2.png', 'active', 30.00],
    ['creator_3', 'Robert', '@robert_visuals', 'avatar_3.png', 'active', 30.00],
    ['creator_4', 'Sarah', '@sarah_lifestyle', 'avatar_full.png', 'active', 30.00]
  ];

  for (const c of initialCreators) {
    insertCreator.run(...c);
  }
}

module.exports = db;
