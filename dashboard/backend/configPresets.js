// Config Presets Storage - SQLite Backend
// Stores trading configuration presets per strategy with isDefault flag

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

  // Drop old table if exists (schema changed)
  db.run(`DROP TABLE IF EXISTS config_presets`);

  // Create table with strategy field
  db.run(`
    CREATE TABLE IF NOT EXISTS strategy_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(strategy, name)
    )
  `);

  // Create index for fast default lookup
  db.run(`CREATE INDEX IF NOT EXISTS idx_strategy_default ON strategy_presets(strategy, is_default)`);

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
 * Get all presets for a strategy
 */
export function getPresetsByStrategy(strategy) {
  if (!db) throw new Error('Database not initialized');

  const stmt = db.prepare(`
    SELECT id, strategy, name, config, is_default, created_at, updated_at
    FROM strategy_presets
    WHERE strategy = ?
    ORDER BY name ASC
  `);
  stmt.bind([strategy]);

  const results = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push({
      id: row.id,
      strategy: row.strategy,
      name: row.name,
      config: JSON.parse(row.config),
      isDefault: row.is_default === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  stmt.free();
  return results;
}

/**
 * Get all presets (all strategies)
 */
export function getAllPresets() {
  if (!db) throw new Error('Database not initialized');

  const results = db.exec(`
    SELECT id, strategy, name, config, is_default, created_at, updated_at
    FROM strategy_presets
    ORDER BY strategy, name ASC
  `);

  if (!results.length) return [];

  return results[0].values.map(row => ({
    id: row[0],
    strategy: row[1],
    name: row[2],
    config: JSON.parse(row[3]),
    isDefault: row[4] === 1,
    createdAt: row[5],
    updatedAt: row[6],
  }));
}

/**
 * Get a preset by strategy and name
 */
export function getPreset(strategy, name) {
  if (!db) throw new Error('Database not initialized');

  const stmt = db.prepare(`
    SELECT id, strategy, name, config, is_default, created_at, updated_at
    FROM strategy_presets
    WHERE strategy = ? AND name = ?
  `);
  stmt.bind([strategy, name]);

  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return {
      id: row.id,
      strategy: row.strategy,
      name: row.name,
      config: JSON.parse(row.config),
      isDefault: row.is_default === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  stmt.free();
  return null;
}

/**
 * Get the default preset for a strategy
 */
export function getDefaultPreset(strategy) {
  if (!db) throw new Error('Database not initialized');

  const stmt = db.prepare(`
    SELECT id, strategy, name, config, is_default, created_at, updated_at
    FROM strategy_presets
    WHERE strategy = ? AND is_default = 1
    LIMIT 1
  `);
  stmt.bind([strategy]);

  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return {
      id: row.id,
      strategy: row.strategy,
      name: row.name,
      config: JSON.parse(row.config),
      isDefault: true,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  stmt.free();
  return null;
}

/**
 * Get all default presets (one per strategy)
 */
export function getAllDefaults() {
  if (!db) throw new Error('Database not initialized');

  const results = db.exec(`
    SELECT id, strategy, name, config, is_default, created_at, updated_at
    FROM strategy_presets
    WHERE is_default = 1
  `);

  if (!results.length) return [];

  return results[0].values.map(row => ({
    id: row[0],
    strategy: row[1],
    name: row[2],
    config: JSON.parse(row[3]),
    isDefault: true,
    createdAt: row[5],
    updatedAt: row[6],
  }));
}

/**
 * Save or update a preset
 */
export function savePreset({ strategy, name, config, isDefault = false }) {
  if (!db) throw new Error('Database not initialized');

  const now = Date.now();
  const configJson = JSON.stringify(config);

  // If setting as default, clear other defaults for this strategy first
  if (isDefault) {
    db.run(`UPDATE strategy_presets SET is_default = 0 WHERE strategy = ?`, [strategy]);
  }

  // Check if preset exists
  const existing = getPreset(strategy, name);

  if (existing) {
    // Update
    db.run(`
      UPDATE strategy_presets
      SET config = ?, is_default = ?, updated_at = ?
      WHERE strategy = ? AND name = ?
    `, [configJson, isDefault ? 1 : 0, now, strategy, name]);
  } else {
    // Insert
    db.run(`
      INSERT INTO strategy_presets (strategy, name, config, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [strategy, name, configJson, isDefault ? 1 : 0, now, now]);
  }

  saveDatabase();
  console.log(`[PRESETS] Saved ${strategy}/${name} (default: ${isDefault})`);
  return getPreset(strategy, name);
}

/**
 * Set a preset as default (clears other defaults for that strategy)
 */
export function setAsDefault(strategy, name) {
  if (!db) throw new Error('Database not initialized');

  // Clear all defaults for this strategy
  db.run(`UPDATE strategy_presets SET is_default = 0 WHERE strategy = ?`, [strategy]);

  // Set this one as default
  db.run(`
    UPDATE strategy_presets
    SET is_default = 1, updated_at = ?
    WHERE strategy = ? AND name = ?
  `, [Date.now(), strategy, name]);

  saveDatabase();
  console.log(`[PRESETS] Set default: ${strategy}/${name}`);
  return getPreset(strategy, name);
}

/**
 * Clear the default for a strategy
 */
export function clearDefault(strategy) {
  if (!db) throw new Error('Database not initialized');
  db.run(`UPDATE strategy_presets SET is_default = 0 WHERE strategy = ?`, [strategy]);
  saveDatabase();
  console.log(`[PRESETS] Cleared default for ${strategy}`);
}

/**
 * Delete a preset
 */
export function deletePreset(strategy, name) {
  if (!db) throw new Error('Database not initialized');
  db.run(`DELETE FROM strategy_presets WHERE strategy = ? AND name = ?`, [strategy, name]);
  saveDatabase();
  console.log(`[PRESETS] Deleted ${strategy}/${name}`);
}
