// Config Presets Storage - SQLite Backend
// Stores trading configuration presets with default flag

import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'presets.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db = null;
let SQL = null;

/**
 * Initialize the SQLite database
 */
export async function initPresetsDatabase() {
  if (db) return db;

  SQL = await initSqlJs();

  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('[PRESETS DB] Loaded existing database');
  } else {
    db = new SQL.Database();
    console.log('[PRESETS DB] Created new database');
  }

  // Create table
  db.run(`
    CREATE TABLE IF NOT EXISTS config_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      position_size INTEGER NOT NULL DEFAULT 1,
      warmup_seconds INTEGER NOT NULL DEFAULT 60,
      selected_assets TEXT NOT NULL DEFAULT 'BTC',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  saveDatabase();
  return db;
}

/**
 * Save database to disk
 */
function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

/**
 * Get all presets
 */
export function getAllPresets() {
  if (!db) throw new Error('Database not initialized');

  const results = db.exec(`
    SELECT id, name, position_size, warmup_seconds, selected_assets, is_default, created_at, updated_at
    FROM config_presets
    ORDER BY name ASC
  `);

  if (!results.length) return [];

  return results[0].values.map(row => ({
    id: row[0],
    name: row[1],
    positionSize: row[2],
    warmupSeconds: row[3],
    selectedAssets: row[4].split(','),
    isDefault: row[5] === 1,
    createdAt: row[6],
    updatedAt: row[7],
  }));
}

/**
 * Get a preset by name
 */
export function getPresetByName(name) {
  if (!db) throw new Error('Database not initialized');

  const results = db.exec(`
    SELECT id, name, position_size, warmup_seconds, selected_assets, is_default, created_at, updated_at
    FROM config_presets
    WHERE name = ?
  `, [name]);

  if (!results.length || !results[0].values.length) return null;

  const row = results[0].values[0];
  return {
    id: row[0],
    name: row[1],
    positionSize: row[2],
    warmupSeconds: row[3],
    selectedAssets: row[4].split(','),
    isDefault: row[5] === 1,
    createdAt: row[6],
    updatedAt: row[7],
  };
}

/**
 * Get the default preset
 */
export function getDefaultPreset() {
  if (!db) throw new Error('Database not initialized');

  const results = db.exec(`
    SELECT id, name, position_size, warmup_seconds, selected_assets, is_default, created_at, updated_at
    FROM config_presets
    WHERE is_default = 1
    LIMIT 1
  `);

  if (!results.length || !results[0].values.length) return null;

  const row = results[0].values[0];
  return {
    id: row[0],
    name: row[1],
    positionSize: row[2],
    warmupSeconds: row[3],
    selectedAssets: row[4].split(','),
    isDefault: true,
    createdAt: row[6],
    updatedAt: row[7],
  };
}

/**
 * Save or update a preset
 */
export function savePreset({ name, positionSize, warmupSeconds, selectedAssets, isDefault = false }) {
  if (!db) throw new Error('Database not initialized');

  const now = Date.now();
  const assetsStr = Array.isArray(selectedAssets) ? selectedAssets.join(',') : selectedAssets;

  // If setting as default, clear other defaults first
  if (isDefault) {
    db.run(`UPDATE config_presets SET is_default = 0 WHERE is_default = 1`);
  }

  // Check if preset exists
  const existing = getPresetByName(name);

  if (existing) {
    // Update
    db.run(`
      UPDATE config_presets
      SET position_size = ?, warmup_seconds = ?, selected_assets = ?, is_default = ?, updated_at = ?
      WHERE name = ?
    `, [positionSize, warmupSeconds, assetsStr, isDefault ? 1 : 0, now, name]);
  } else {
    // Insert
    db.run(`
      INSERT INTO config_presets (name, position_size, warmup_seconds, selected_assets, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [name, positionSize, warmupSeconds, assetsStr, isDefault ? 1 : 0, now, now]);
  }

  saveDatabase();
  return getPresetByName(name);
}

/**
 * Set a preset as default (clears other defaults)
 */
export function setPresetAsDefault(name) {
  if (!db) throw new Error('Database not initialized');

  // Clear all defaults
  db.run(`UPDATE config_presets SET is_default = 0`);

  // Set this one as default
  db.run(`UPDATE config_presets SET is_default = 1, updated_at = ? WHERE name = ?`, [Date.now(), name]);

  saveDatabase();
  return getPresetByName(name);
}

/**
 * Clear the default preset
 */
export function clearDefault() {
  if (!db) throw new Error('Database not initialized');
  db.run(`UPDATE config_presets SET is_default = 0`);
  saveDatabase();
}

/**
 * Delete a preset
 */
export function deletePreset(name) {
  if (!db) throw new Error('Database not initialized');
  db.run(`DELETE FROM config_presets WHERE name = ?`, [name]);
  saveDatabase();
}
