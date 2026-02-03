// Audit Log Storage - SQLite Backend
// Stores trading audit events for analysis and AI review

import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'audit.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db = null;
let SQL = null;

/**
 * Initialize the SQLite database
 */
export async function initDatabase() {
  if (db) return db;

  SQL = await initSqlJs();

  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('[AUDIT DB] Loaded existing database');
  } else {
    db = new SQL.Database();
    console.log('[AUDIT DB] Created new database');
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_entries (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      asset TEXT NOT NULL,
      strategy TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      yes_price REAL,
      no_price REAL,
      yes_liquidity REAL,
      no_liquidity REAL,
      time_remaining_ms INTEGER,
      position_side TEXT,
      position_shares REAL,
      position_avg_price REAL,
      position_unrealized_pnl REAL,
      decision_action TEXT,
      decision_reason TEXT,
      decision_data TEXT,
      outcome_fill_price REAL,
      outcome_shares REAL,
      outcome_pnl REAL,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      asset TEXT NOT NULL,
      strategy TEXT NOT NULL,
      market_id TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      total_entries INTEGER DEFAULT 0,
      total_exits INTEGER DEFAULT 0,
      hedge_count INTEGER DEFAULT 0,
      final_pnl REAL DEFAULT 0,
      peak_pnl REAL DEFAULT 0,
      trough_pnl REAL DEFAULT 0,
      winning_trades INTEGER DEFAULT 0,
      losing_trades INTEGER DEFAULT 0,
      ai_grade TEXT,
      ai_summary TEXT,
      ai_analysis TEXT,
      analyzed_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    )
  `);

  // Create indexes for common queries
  db.run(`CREATE INDEX IF NOT EXISTS idx_entries_session ON audit_entries(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON audit_entries(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_entries_asset ON audit_entries(asset)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_time)`);

  // Save initial database
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

// Auto-save every 30 seconds
setInterval(() => {
  if (db) saveDatabase();
}, 30000);

// Save on process exit
process.on('SIGINT', () => {
  if (db) {
    console.log('[AUDIT DB] Saving before exit...');
    saveDatabase();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (db) saveDatabase();
  process.exit(0);
});

/**
 * Generate a unique ID
 */
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Log an audit entry
 */
export function logEntry(params) {
  if (!db) {
    console.error('[AUDIT DB] Database not initialized');
    return null;
  }

  const id = generateId();
  const now = Date.now();

  try {
    // sql.js doesn't handle undefined - convert to null
    const toNull = (v) => v === undefined ? null : v;

    db.run(`
      INSERT INTO audit_entries (
        id, timestamp, session_id, asset, strategy, event_type, severity,
        yes_price, no_price, yes_liquidity, no_liquidity, time_remaining_ms,
        position_side, position_shares, position_avg_price, position_unrealized_pnl,
        decision_action, decision_reason, decision_data,
        outcome_fill_price, outcome_shares, outcome_pnl
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      params.timestamp || now,
      params.sessionId,
      params.asset,
      params.strategy,
      params.eventType,
      params.severity || 'info',
      toNull(params.yesPrice),
      toNull(params.noPrice),
      toNull(params.yesLiquidity),
      toNull(params.noLiquidity),
      toNull(params.timeRemainingMs),
      toNull(params.position?.side),
      toNull(params.position?.shares),
      toNull(params.position?.avgPrice),
      toNull(params.position?.unrealizedPnl),
      toNull(params.decision?.action),
      toNull(params.decision?.reason),
      params.decision ? JSON.stringify(params.decision) : null,
      toNull(params.outcome?.fillPrice),
      toNull(params.outcome?.shares),
      toNull(params.outcome?.pnl),
    ]);

    // Update or create session
    upsertSession(params);

    return { id, timestamp: now };
  } catch (e) {
    console.error('[AUDIT DB] Failed to log entry:', e?.message || e);
    return null;
  }
}

/**
 * Update or insert session record
 */
function upsertSession(params) {
  try {
    // Use prepared statement for SELECT
    const stmt = db.prepare(`SELECT session_id FROM sessions WHERE session_id = ?`);
    stmt.bind([params.sessionId]);
    const exists = stmt.step();
    stmt.free();

    if (!exists) {
      // Create new session
      db.run(`
        INSERT INTO sessions (session_id, asset, strategy, market_id, start_time, end_time)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        params.sessionId,
        params.asset,
        params.strategy,
        params.sessionId.replace(/-mom$|-dual$/, ''),
        params.timestamp || Date.now(),
        params.endTime,
      ]);
    }
  } catch (e) {
    console.error('[AUDIT DB] Failed to upsert session:', e?.message || e);
  }

  // Update session stats based on event type
  const eventType = params.eventType;
  const now = Date.now();

  if (eventType === 'ENTRY_FILL' || eventType === 'MAKER_ORDER_FILLED') {
    db.run(`UPDATE sessions SET total_entries = total_entries + 1, updated_at = ? WHERE session_id = ?`,
      [now, params.sessionId]);
  }
  if (eventType === 'HEDGE_FILL') {
    db.run(`UPDATE sessions SET hedge_count = hedge_count + 1, updated_at = ? WHERE session_id = ?`,
      [now, params.sessionId]);
  }
  // Exit events that should update P&L and exit count
  // Includes both dual-entry events (LOSER_EXIT, WINNER_EXIT, FORCE_EXIT)
  // and momentum events (TAKE_PROFIT, CLOSE_EXECUTED, HEDGE_EXECUTED)
  const exitEvents = ['TAKE_PROFIT', 'LOSER_EXIT', 'WINNER_EXIT', 'FORCE_EXIT', 'CLOSE_EXECUTED', 'HEDGE_EXECUTED'];
  if (exitEvents.includes(eventType)) {
    // Don't count HEDGE_EXECUTED as an "exit" since momentum can re-enter
    if (eventType !== 'HEDGE_EXECUTED') {
      db.run(`UPDATE sessions SET total_exits = total_exits + 1, updated_at = ? WHERE session_id = ?`,
        [now, params.sessionId]);
    }

    if (params.outcome?.pnl !== undefined) {
      const pnl = params.outcome.pnl;
      db.run(`
        UPDATE sessions SET
          final_pnl = ?,
          peak_pnl = MAX(peak_pnl, ?),
          trough_pnl = MIN(trough_pnl, ?),
          winning_trades = winning_trades + CASE WHEN ? > 0 THEN 1 ELSE 0 END,
          losing_trades = losing_trades + CASE WHEN ? < 0 THEN 1 ELSE 0 END,
          updated_at = ?
        WHERE session_id = ?
      `, [pnl, pnl, pnl, pnl, pnl, now, params.sessionId]);
    }
  }
}

/**
 * Get entries for a session
 */
export function getSessionEntries(sessionId, limit = 500) {
  if (!db) return [];

  const result = db.exec(`
    SELECT * FROM audit_entries
    WHERE session_id = ?
    ORDER BY timestamp ASC
    LIMIT ?
  `, [sessionId, limit]);

  return resultToObjects(result);
}

/**
 * Get session info
 */
export function getSession(sessionId) {
  if (!db) return null;

  const result = db.exec(`SELECT * FROM sessions WHERE session_id = ?`, [sessionId]);
  const sessions = resultToObjects(result);
  return sessions[0] || null;
}

/**
 * Get all sessions
 */
export function getSessions(limit = 100, offset = 0) {
  if (!db) return [];

  const result = db.exec(`
    SELECT * FROM sessions
    ORDER BY start_time DESC
    LIMIT ? OFFSET ?
  `, [limit, offset]);

  return resultToObjects(result);
}

/**
 * Get entries with filters
 */
export function getEntries(filters = {}) {
  if (!db) return [];

  let sql = 'SELECT * FROM audit_entries WHERE 1=1';
  const params = [];

  if (filters.sessionId) {
    sql += ' AND session_id = ?';
    params.push(filters.sessionId);
  }
  if (filters.asset) {
    sql += ' AND asset = ?';
    params.push(filters.asset);
  }
  if (filters.strategy) {
    sql += ' AND strategy = ?';
    params.push(filters.strategy);
  }
  if (filters.eventTypes?.length) {
    sql += ` AND event_type IN (${filters.eventTypes.map(() => '?').join(',')})`;
    params.push(...filters.eventTypes);
  }
  if (filters.since) {
    sql += ' AND timestamp >= ?';
    params.push(filters.since);
  }

  sql += ' ORDER BY timestamp DESC';

  if (filters.limit) {
    sql += ' LIMIT ?';
    params.push(filters.limit);
  }

  const result = db.exec(sql, params);
  return resultToObjects(result);
}

/**
 * Export session to markdown for AI review
 */
export function exportSessionToMarkdown(sessionId) {
  const session = getSession(sessionId);
  if (!session) return 'Session not found';

  const entries = getSessionEntries(sessionId);

  const lines = [
    `# Trade Audit: ${session.asset} (${session.strategy})`,
    '',
    `**Session ID:** ${session.session_id}`,
    `**Start:** ${new Date(session.start_time).toLocaleString()}`,
    `**End:** ${session.end_time ? new Date(session.end_time).toLocaleString() : 'Ongoing'}`,
    '',
    '## Summary',
    `- Total Entries: ${session.total_entries}`,
    `- Total Exits: ${session.total_exits}`,
    `- Hedges: ${session.hedge_count}`,
    `- Final P&L: $${(session.final_pnl || 0).toFixed(2)}`,
    `- Peak P&L: $${(session.peak_pnl || 0).toFixed(2)}`,
    `- Trough P&L: $${(session.trough_pnl || 0).toFixed(2)}`,
    `- Winning Trades: ${session.winning_trades}`,
    `- Losing Trades: ${session.losing_trades}`,
    '',
    '## Event Log',
    '',
  ];

  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const remaining = entry.time_remaining_ms
      ? `${Math.floor(entry.time_remaining_ms / 60000)}:${String(Math.floor((entry.time_remaining_ms % 60000) / 1000)).padStart(2, '0')}`
      : 'N/A';

    lines.push(`### ${time} [${remaining} left] - ${entry.event_type}`);
    lines.push('');
    lines.push(`**Severity:** ${entry.severity}`);
    lines.push(`**Prices:** YES=${((entry.yes_price || 0) * 100).toFixed(1)}¢, NO=${((entry.no_price || 0) * 100).toFixed(1)}¢`);

    if (entry.position_side) {
      lines.push(`**Position:** ${entry.position_side} ${(entry.position_shares || 0).toFixed(1)} shares @ ${((entry.position_avg_price || 0) * 100).toFixed(1)}¢`);
    }

    lines.push(`**Action:** ${entry.decision_action || 'N/A'}`);
    lines.push(`**Reason:** ${entry.decision_reason || 'N/A'}`);

    if (entry.outcome_pnl !== null) {
      lines.push(`**Outcome:** Fill @ ${((entry.outcome_fill_price || 0) * 100).toFixed(1)}¢, P&L: $${(entry.outcome_pnl || 0).toFixed(2)}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Save AI analysis for a session
 */
export function saveAiAnalysis(sessionId, analysis) {
  if (!db) return false;

  try {
    db.run(`
      UPDATE sessions SET
        ai_grade = ?,
        ai_summary = ?,
        ai_analysis = ?,
        analyzed_at = ?,
        updated_at = ?
      WHERE session_id = ?
    `, [
      analysis.grade,
      analysis.summary,
      JSON.stringify(analysis),
      Date.now(),
      Date.now(),
      sessionId,
    ]);
    saveDatabase();
    return true;
  } catch (e) {
    console.error('[AUDIT DB] Failed to save AI analysis:', e.message);
    return false;
  }
}

/**
 * Get database stats
 */
export function getStats() {
  if (!db) return null;

  const entryCount = db.exec('SELECT COUNT(*) as count FROM audit_entries');
  const sessionCount = db.exec('SELECT COUNT(*) as count FROM sessions');
  const recentSessions = db.exec(`
    SELECT asset, strategy, final_pnl, start_time
    FROM sessions
    ORDER BY start_time DESC
    LIMIT 5
  `);

  return {
    totalEntries: entryCount[0]?.values[0]?.[0] || 0,
    totalSessions: sessionCount[0]?.values[0]?.[0] || 0,
    recentSessions: resultToObjects(recentSessions),
    dbPath: DB_PATH,
  };
}

/**
 * Get daily stats from database (persisted across restarts)
 */
export function getDailyStats() {
  if (!db) return null;

  // Get today's start timestamp (midnight local time)
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  // All-time stats
  const allTimeResult = db.exec(`
    SELECT 
      SUM(final_pnl) as total_pnl,
      SUM(winning_trades) as wins,
      SUM(losing_trades) as losses
    FROM sessions
  `);

  // Today's stats
  const todayResult = db.exec(`
    SELECT 
      SUM(final_pnl) as total_pnl,
      SUM(winning_trades) as wins,
      SUM(losing_trades) as losses
    FROM sessions 
    WHERE start_time >= ?
  `, [todayStart]);

  // Per-strategy breakdown for today
  const strategyResult = db.exec(`
    SELECT 
      strategy,
      SUM(final_pnl) as total_pnl,
      SUM(winning_trades) as wins,
      SUM(losing_trades) as losses,
      COUNT(*) as sessions
    FROM sessions 
    WHERE start_time >= ?
    GROUP BY strategy
  `, [todayStart]);

  const allTime = allTimeResult[0]?.values[0] || [0, 0, 0];
  const today = todayResult[0]?.values[0] || [0, 0, 0];
  const strategies = resultToObjects(strategyResult);

  const strategyStats = {};
  for (const s of strategies) {
    strategyStats[s.strategy] = {
      pnl: s.total_pnl || 0,
      wins: s.wins || 0,
      losses: s.losses || 0,
      sessions: s.sessions || 0,
    };
  }

  return {
    allTime: {
      pnl: allTime[0] || 0,
      wins: allTime[1] || 0,
      losses: allTime[2] || 0,
    },
    today: {
      pnl: today[0] || 0,
      wins: today[1] || 0,
      losses: today[2] || 0,
    },
    byStrategy: strategyStats,
    todayStart,
  };
}

/**
 * Clear old data (keep last N days)
 */
export function cleanup(daysToKeep = 7) {
  if (!db) return;

  const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

  db.run('DELETE FROM audit_entries WHERE timestamp < ?', [cutoff]);
  db.run('DELETE FROM sessions WHERE start_time < ?', [cutoff]);

  saveDatabase();
  console.log(`[AUDIT DB] Cleaned up data older than ${daysToKeep} days`);
}

/**
 * Convert SQL.js result to array of objects
 */
function resultToObjects(result) {
  if (!result || result.length === 0) return [];

  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

export default {
  initDatabase,
  logEntry,
  getSession,
  getSessions,
  getSessionEntries,
  getEntries,
  exportSessionToMarkdown,
  saveAiAnalysis,
  getStats,
  getDailyStats,
  cleanup,
};
