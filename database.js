import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// Set up db path
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, 'trading_journal.db');

// Enable verbose mode for debugging
const sqlite = sqlite3.verbose();

// Initialize the database connection
const db = new sqlite.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite database at:', dbPath);
    // Enable Foreign Key support
    db.run('PRAGMA foreign_keys = ON;', (err) => {
      if (err) console.error('Error enabling foreign keys:', err.message);
    });
  }
});

// Wrap callback-based sqlite methods in Promises
export const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve({ id: this.lastID, changes: this.changes });
      }
    });
  });
};

export const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
};

export const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
};

// Database Schema Initialization
export const initDatabase = async () => {
  try {
    // 1. Users Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        is_premium INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. Profiles Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS profiles (
        user_id INTEGER PRIMARY KEY,
        broker TEXT DEFAULT '',
        style TEXT DEFAULT '',
        starting_capital REAL DEFAULT 0.0,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 3. Trades Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        ticket TEXT NOT NULL,
        open_time TEXT NOT NULL,
        close_time TEXT NOT NULL,
        type TEXT NOT NULL,
        symbol TEXT NOT NULL,
        lots REAL NOT NULL,
        profit REAL NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, ticket, close_time)
      )
    `);

    // 4. Virtual Groups Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS virtual_groups (
        user_id INTEGER NOT NULL,
        group_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        tickets TEXT NOT NULL,
        notes TEXT DEFAULT '',
        PRIMARY KEY (user_id, group_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Add daily rules columns to profiles if they don't exist
    try { await dbRun("ALTER TABLE profiles ADD COLUMN daily_loss_limit REAL DEFAULT 0.0"); } catch(e) {}
    try { await dbRun("ALTER TABLE profiles ADD COLUMN daily_profit_target REAL DEFAULT 0.0"); } catch(e) {}
    try { await dbRun("ALTER TABLE profiles ADD COLUMN daily_loss_type TEXT DEFAULT 'usd'"); } catch(e) {}

    // Add note, timeframe, screenshot columns to trades if they don't exist
    try { await dbRun("ALTER TABLE trades ADD COLUMN timeframe TEXT DEFAULT ''"); } catch(e) {}
    try { await dbRun("ALTER TABLE trades ADD COLUMN notes TEXT DEFAULT ''"); } catch(e) {}
    try { await dbRun("ALTER TABLE trades ADD COLUMN screenshot_url TEXT DEFAULT ''"); } catch(e) {}

    console.log('Database tables initialized successfully.');
  } catch (err) {
    console.error('Error initializing database tables:', err.message);
    throw err;
  }
};

export default db;
