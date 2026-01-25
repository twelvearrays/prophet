// Price History Storage
// Stores price ticks per session in JSON files for persistent chart data

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Storage directory
const DATA_DIR = path.join(__dirname, 'data', 'price-history');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory cache for fast access
const priceCache = new Map(); // marketId -> { ticks: [], lastSave: timestamp }

// Save interval (save to disk every 10 seconds to avoid too many writes)
const SAVE_INTERVAL_MS = 10000;
// Max ticks per session (15 min = 900 seconds, 1 tick/sec = 900 ticks max)
const MAX_TICKS = 1000;
// Auto-cleanup: delete files older than 24 hours
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Get file path for a market's price history
 */
function getFilePath(marketId) {
  // Sanitize marketId for filename
  const safeId = marketId.replace(/[^a-zA-Z0-9-]/g, '_');
  return path.join(DATA_DIR, `${safeId}.json`);
}

/**
 * Load price history from disk
 */
function loadFromDisk(marketId) {
  const filePath = getFilePath(marketId);
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return data;
    }
  } catch (e) {
    console.error(`[PRICE HISTORY] Failed to load ${marketId}:`, e.message);
  }
  return null;
}

/**
 * Save price history to disk
 */
function saveToDisk(marketId, data) {
  const filePath = getFilePath(marketId);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[PRICE HISTORY] Failed to save ${marketId}:`, e.message);
  }
}

/**
 * Add a price tick to history
 */
export function addPriceTick(marketId, tick) {
  if (!marketId || !tick) return;

  // Get or create cache entry
  let cache = priceCache.get(marketId);
  if (!cache) {
    // Try to load from disk first
    const diskData = loadFromDisk(marketId);
    cache = diskData || {
      marketId,
      ticks: [],
      startTime: Date.now(),
      lastSave: 0,
    };
    priceCache.set(marketId, cache);
  }

  // Add tick with timestamp
  const priceTick = {
    t: tick.timestamp || Date.now(),
    y: tick.yesPrice,
    n: tick.noPrice,
    yl: tick.yesLiquidity,
    nl: tick.noLiquidity,
  };

  // Avoid duplicate timestamps (within 500ms)
  const lastTick = cache.ticks[cache.ticks.length - 1];
  if (lastTick && Math.abs(priceTick.t - lastTick.t) < 500) {
    return; // Skip duplicate
  }

  cache.ticks.push(priceTick);

  // Trim to max size
  if (cache.ticks.length > MAX_TICKS) {
    cache.ticks = cache.ticks.slice(-MAX_TICKS);
  }

  // Periodic save to disk
  const now = Date.now();
  if (now - cache.lastSave > SAVE_INTERVAL_MS) {
    cache.lastSave = now;
    saveToDisk(marketId, cache);
  }
}

/**
 * Get price history for a market
 */
export function getPriceHistory(marketId) {
  // Check cache first
  let cache = priceCache.get(marketId);

  if (!cache) {
    // Try to load from disk
    const diskData = loadFromDisk(marketId);
    if (diskData) {
      priceCache.set(marketId, diskData);
      cache = diskData;
    }
  }

  if (!cache) {
    return { marketId, ticks: [], startTime: null };
  }

  // Convert compact format back to full format
  const ticks = cache.ticks.map(t => ({
    timestamp: t.t,
    yesPrice: t.y,
    noPrice: t.n,
    yesLiquidity: t.yl || 100,
    noLiquidity: t.nl || 100,
  }));

  return {
    marketId,
    ticks,
    startTime: cache.startTime,
    tickCount: ticks.length,
  };
}

/**
 * Get all active price histories
 */
export function getAllPriceHistories() {
  const histories = [];

  // Get from cache
  for (const [marketId, cache] of priceCache.entries()) {
    histories.push({
      marketId,
      tickCount: cache.ticks.length,
      startTime: cache.startTime,
      lastTick: cache.ticks[cache.ticks.length - 1]?.t,
    });
  }

  return histories;
}

/**
 * Force save all cached data to disk
 */
export function saveAll() {
  for (const [marketId, cache] of priceCache.entries()) {
    cache.lastSave = Date.now();
    saveToDisk(marketId, cache);
  }
  console.log(`[PRICE HISTORY] Saved ${priceCache.size} market histories to disk`);
}

/**
 * Cleanup old files
 */
export function cleanup() {
  try {
    const files = fs.readdirSync(DATA_DIR);
    const now = Date.now();
    let deleted = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(DATA_DIR, file);
      const stats = fs.statSync(filePath);

      if (now - stats.mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    }

    if (deleted > 0) {
      console.log(`[PRICE HISTORY] Cleaned up ${deleted} old files`);
    }
  } catch (e) {
    console.error('[PRICE HISTORY] Cleanup error:', e.message);
  }
}

/**
 * Clear history for a specific market
 */
export function clearHistory(marketId) {
  priceCache.delete(marketId);
  const filePath = getFilePath(marketId);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    // Ignore
  }
}

// Run cleanup on startup
cleanup();

// Save all data periodically (every 30 seconds)
setInterval(saveAll, 30000);

// Save on process exit
process.on('SIGINT', () => {
  console.log('[PRICE HISTORY] Saving before exit...');
  saveAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveAll();
  process.exit(0);
});

export default {
  addPriceTick,
  getPriceHistory,
  getAllPriceHistories,
  saveAll,
  cleanup,
  clearHistory,
};
