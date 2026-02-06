// Polymarket Backend Server
// Uses official @polymarket/clob-client for API access
// Provides REST endpoints + WebSocket streaming for the React dashboard

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ClobClient } from '@polymarket/clob-client';
import * as trading from './trading.js';
import * as priceHistory from './priceHistory.js';
import * as auditStorage from './auditStorage.js';
import * as configPresets from './configPresets.js';

// New Frank-Wolfe arbitrage modules
import { validateType1Market, validatePriceSum } from './marketValidator.js';
import { FrankWolfeEngine, analyzeArbitrage } from './frankWolfe.js';
import { SettlementLagScanner, scanSettlementLag } from './settlementLag.js';
import { DependencyGraph, analyzeCrossMarketDependencies as analyzeType2Dependencies } from './dependencyGraph.js';

// Mock data for testing when API is unreachable
import { MOCK_EVENTS, USE_MOCK_DATA, getMockEvents } from './mockData.js';

const app = express();
const PORT = 3001;
const WS_PORT = 3002;

app.use(cors());
app.use(express.json());

// Initialize CLOB client (read-only, no wallet needed for public data)
const rawClobClient = new ClobClient(
  'https://clob.polymarket.com',
  137 // Polygon chain ID
);

// Store original console.error ONCE at module load to prevent recursion
const _originalConsoleError = console.error.bind(console);

// Global suppression of CLOB Client verbose error logs
// These 404s are expected for markets that haven't started or have expired
console.error = (...args) => {
  const firstArg = args[0];
  // Suppress CLOB Client request errors (they log full axios configs)
  if (typeof firstArg === 'string' && firstArg.includes('[CLOB Client]')) {
    return;
  }
  // Also suppress if it's an object that looks like an axios error config
  if (typeof firstArg === 'object' && firstArg?.config?.url?.includes('clob.polymarket.com')) {
    return;
  }
  _originalConsoleError(...args);
};

// Wrapper to suppress verbose CLOB client error logs for expected 404s
// The library logs full request configs which spam the console
const clobClient = {
  async getOrderBook(tokenId) {
    console.error = (...args) => {
      // Suppress CLOB Client request error logs (they're verbose and expected for new markets)
      if (args[0]?.includes?.('[CLOB Client]') || (typeof args[0] === 'string' && args[0].includes('[CLOB Client]'))) {
        return;
      }
      _originalConsoleError(...args);
    };
    try {
      return await rawClobClient.getOrderBook(tokenId);
    } finally {
      console.error = _originalConsoleError;
    }
  },
  async getMidpoint(tokenId) {
    console.error = (...args) => {
      if (args[0]?.includes?.('[CLOB Client]') || (typeof args[0] === 'string' && args[0].includes('[CLOB Client]'))) {
        return;
      }
      _originalConsoleError(...args);
    };
    try {
      return await rawClobClient.getMidpoint(tokenId);
    } finally {
      console.error = _originalConsoleError;
    }
  },
  async getSpread(tokenId) {
    console.error = (...args) => {
      if (args[0]?.includes?.('[CLOB Client]') || (typeof args[0] === 'string' && args[0].includes('[CLOB Client]'))) {
        return;
      }
      _originalConsoleError(...args);
    };
    try {
      return await rawClobClient.getSpread(tokenId);
    } finally {
      console.error = _originalConsoleError;
    }
  },
  async getMarket(conditionId) {
    return rawClobClient.getMarket(conditionId);
  },
  async getMarkets() {
    return rawClobClient.getMarkets();
  },
  async getSimplifiedMarkets() {
    return rawClobClient.getSimplifiedMarkets();
  },
};

// Gamma API for market discovery
const GAMMA_API = 'https://gamma-api.polymarket.com';

// Polymarket WebSocket for real-time prices
const POLYMARKET_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// ============================================================================
// WEBSOCKET SERVER - Streams prices to React dashboard
// ============================================================================

const server = http.createServer(app);
const wss = new WebSocketServer({ port: WS_PORT });

// Track subscriptions: tokenId -> Set of client websockets
const subscriptions = new Map();
// Pending subscriptions (tokens to subscribe when Polymarket reconnects)
let pendingSubscriptions = new Set();
// Polymarket WS connection
let polymarketWs = null;
let polymarketWsConnected = false;
let reconnectTimeout = null;

// Connect to Polymarket WebSocket
function connectToPolymarket() {
  if (polymarketWs) {
    try { polymarketWs.close(); } catch (e) {}
  }

  console.log('[WS] Connecting to Polymarket WebSocket...');
  polymarketWs = new WebSocket(POLYMARKET_WS_URL);

  polymarketWs.on('open', () => {
    console.log('[WS] Connected to Polymarket');
    polymarketWsConnected = true;

    // Re-subscribe to all tokens (both active subscriptions and pending)
    const allTokens = new Set([
      ...Array.from(subscriptions.keys()),
      ...Array.from(pendingSubscriptions)
    ]);

    if (allTokens.size > 0) {
      subscribeToTokens(Array.from(allTokens));
      pendingSubscriptions.clear();
    }
  });

  polymarketWs.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handlePolymarketMessage(message);
    } catch (e) {
      // Skip non-JSON messages
    }
  });

  polymarketWs.on('close', () => {
    console.log('[WS] Polymarket connection closed');
    polymarketWsConnected = false;
    scheduleReconnect();
  });

  polymarketWs.on('error', (err) => {
    console.error('[WS] Polymarket error:', err.message);
    polymarketWsConnected = false;
  });
}

function scheduleReconnect() {
  if (reconnectTimeout) return;
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connectToPolymarket();
  }, 5000);
}

function subscribeToTokens(tokenIds) {
  if (!polymarketWs || polymarketWs.readyState !== WebSocket.OPEN) {
    console.log(`[WS] Cannot subscribe - Polymarket WS not open (state: ${polymarketWs?.readyState})`);
    // Queue tokens for when connection is restored
    for (const tokenId of tokenIds) {
      pendingSubscriptions.add(tokenId);
    }
    return false;
  }

  const msg = {
    assets_ids: tokenIds,
    type: 'market',
  };
  polymarketWs.send(JSON.stringify(msg));
  console.log(`[WS] Subscribed to ${tokenIds.length} tokens:`, tokenIds.map(t => t.slice(0, 8) + '...'));
  return true;
}

function handlePolymarketMessage(data) {
  // Handle array of orderbooks
  if (Array.isArray(data)) {
    for (const item of data) {
      processOrderbook(item);
    }
    return;
  }

  // Handle price_change events
  if (data.event_type === 'price_change') {
    const changes = data.price_changes || [];
    for (const change of changes) {
      processPriceChange(change);
    }
    return;
  }

  // Handle orderbook updates
  if (data.bids || data.asks) {
    processOrderbook(data);
  }
}

function processPriceChange(change) {
  const tokenId = change.asset_id;
  if (!tokenId) return;

  const tick = {
    type: 'price',
    tokenId,
    bestAsk: change.best_ask ? parseFloat(change.best_ask) : null,
    bestBid: change.best_bid ? parseFloat(change.best_bid) : null,
    timestamp: Date.now(),
  };

  broadcastToSubscribers(tokenId, tick);
}

function processOrderbook(data) {
  const tokenId = data.asset_id;
  if (!tokenId) return;

  const asks = data.asks || [];
  const bids = data.bids || [];

  const bestAsk = asks.length > 0
    ? Math.min(...asks.map(a => parseFloat(a.price)))
    : null;
  const bestBid = bids.length > 0
    ? Math.max(...bids.map(b => parseFloat(b.price)))
    : null;

  const liquidity = bids.slice(0, 5).reduce(
    (sum, b) => sum + parseFloat(b.size) * parseFloat(b.price),
    0
  );

  const tick = {
    type: 'price',
    tokenId,
    bestAsk,
    bestBid,
    liquidity,
    timestamp: Date.now(),
  };

  broadcastToSubscribers(tokenId, tick);
}

// Map tokenId to marketId for price history storage
const tokenToMarket = new Map(); // tokenId -> { marketId, side: 'YES' | 'NO' }
// Track latest prices per market for combining YES/NO into ticks
const latestPrices = new Map(); // marketId -> { yesPrice, noPrice, yesLiquidity, noLiquidity, timestamp }

function broadcastToSubscribers(tokenId, data) {
  const clients = subscriptions.get(tokenId);
  if (!clients) return;

  const message = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }

  // Store price in history - combine YES/NO into market ticks
  const tokenInfo = tokenToMarket.get(tokenId);
  if (tokenInfo && data.bestAsk !== null) {
    const { marketId, side } = tokenInfo;

    // Get or create price entry for this market
    let prices = latestPrices.get(marketId);
    if (!prices) {
      prices = { yesPrice: 0.5, noPrice: 0.5, yesLiquidity: 100, noLiquidity: 100, timestamp: 0 };
      latestPrices.set(marketId, prices);
    }

    // Update the appropriate side
    if (side === 'YES') {
      prices.yesPrice = data.bestAsk;
      prices.yesLiquidity = data.liquidity || 100;
    } else {
      prices.noPrice = data.bestAsk;
      prices.noLiquidity = data.liquidity || 100;
    }
    prices.timestamp = data.timestamp;

    // Store combined tick to price history (throttled - only if 500ms since last)
    const lastStoredTime = prices.lastStoredTime || 0;
    if (data.timestamp - lastStoredTime >= 500) {
      prices.lastStoredTime = data.timestamp;
      priceHistory.addPriceTick(marketId, {
        timestamp: data.timestamp,
        yesPrice: prices.yesPrice,
        noPrice: prices.noPrice,
        yesLiquidity: prices.yesLiquidity,
        noLiquidity: prices.noLiquidity,
      });
    }
  }
}

// Handle client WebSocket connections
wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  const clientSubscriptions = new Set();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.action === 'subscribe' && Array.isArray(msg.tokenIds)) {
        console.log(`[WS] Client requesting subscription to ${msg.tokenIds.length} tokens`);

        // Track which tokens are NEW (not already subscribed)
        const newTokens = [];

        for (const tokenId of msg.tokenIds) {
          // Track client subscription
          clientSubscriptions.add(tokenId);

          // Check if this is a new token
          const isNew = !subscriptions.has(tokenId);

          // Add to global subscriptions
          if (!subscriptions.has(tokenId)) {
            subscriptions.set(tokenId, new Set());
          }
          subscriptions.get(tokenId).add(ws);

          if (isNew) {
            newTokens.push(tokenId);
          }
        }

        // Only subscribe to Polymarket for NEW tokens
        if (newTokens.length > 0) {
          console.log(`[WS] ${newTokens.length} NEW tokens to subscribe to Polymarket`);

          if (polymarketWsConnected) {
            const success = subscribeToTokens(newTokens);
            if (!success) {
              console.log(`[WS] Failed to subscribe, will retry on reconnect`);
            }
          } else {
            // Queue for when Polymarket reconnects
            for (const tokenId of newTokens) {
              pendingSubscriptions.add(tokenId);
            }
            console.log(`[WS] Polymarket not connected, queued ${newTokens.length} NEW tokens`);
            // Try to reconnect
            if (!reconnectTimeout) {
              console.log(`[WS] Triggering reconnect for new tokens...`);
              connectToPolymarket();
            }
          }
        } else {
          console.log(`[WS] All ${msg.tokenIds.length} tokens already subscribed`);
        }

        console.log(`[WS] Client now subscribed to ${clientSubscriptions.size} tokens total`);
      }

      if (msg.action === 'unsubscribe' && Array.isArray(msg.tokenIds)) {
        for (const tokenId of msg.tokenIds) {
          clientSubscriptions.delete(tokenId);
          const clients = subscriptions.get(tokenId);
          if (clients) {
            clients.delete(ws);
            if (clients.size === 0) {
              subscriptions.delete(tokenId);
            }
          }
        }
      }
    } catch (e) {
      console.error('[WS] Invalid message:', e);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    // Clean up subscriptions
    for (const tokenId of clientSubscriptions) {
      const clients = subscriptions.get(tokenId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) {
          subscriptions.delete(tokenId);
        }
      }
    }
  });

  // Send initial connection confirmation
  ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
});

// Start Polymarket connection
connectToPolymarket();

// ============================================================================
// MARKET DISCOVERY ENDPOINTS
// ============================================================================

// Helper: Check if market is currently active (started but not ended)
function isMarketActive(startTime, endTime) {
  const now = Date.now();
  const start = startTime instanceof Date ? startTime.getTime() : new Date(startTime).getTime();
  const end = endTime instanceof Date ? endTime.getTime() : new Date(endTime).getTime();
  return now >= start && now < end;
}

// Helper: Parse start time from slug or calculate from end time
function parseStartTime(slug, endTime) {
  // Try to extract timestamp from slug (e.g., "btc-updown-15m-1706198400")
  const match = slug?.match(/-(\d{10})$/);
  if (match) {
    return new Date(parseInt(match[1]) * 1000);
  }
  // Fall back to 15 minutes before end time
  const end = endTime instanceof Date ? endTime : new Date(endTime);
  return new Date(end.getTime() - 15 * 60 * 1000);
}

// Helper: Parse strike price from market question or other fields
// Examples:
//   "Will Bitcoin be above $104,500.00 at 4:00 PM ET?" -> 104500
//   "Will the price of BTC be above $104500 at..." -> 104500
//   "Bitcoin Up or Down: $104,500.00" -> 104500
//   "Bitcoin Up or Down - January 24, 5:00PM-5:15PM ET" with outcomes containing price
function parseStrikePrice(question, market = null) {
  if (!question) return null;

  // Log the full question for debugging
  console.log(`[PARSE] Trying to parse strike price from: "${question}"`);

  // Match price patterns like $104,500.00 or $104500 or $3,245.50
  const match = question.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
  if (match) {
    const price = parseFloat(match[1].replace(/,/g, ''));
    console.log(`[PARSE] ✓ Strike price from question: $${price}`);
    return price;
  }

  // Try to find numbers that look like prices (5+ digits for BTC, 4+ for ETH/SOL)
  const numMatch = question.match(/(?:above|below|at)\s+(\d{3,6}(?:\.\d+)?)/i);
  if (numMatch) {
    const price = parseFloat(numMatch[1]);
    console.log(`[PARSE] ✓ Strike price (numeric): $${price}`);
    return price;
  }

  // Try to extract from market outcomes if available
  if (market) {
    const outcomes = market.outcomes || market.outcomePrices || [];
    const outcomesStr = JSON.stringify(outcomes);
    console.log(`[PARSE] Checking outcomes: ${outcomesStr.slice(0, 200)}`);

    // Check if outcomes contain price info
    const outcomeMatch = outcomesStr.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
    if (outcomeMatch) {
      const price = parseFloat(outcomeMatch[1].replace(/,/g, ''));
      console.log(`[PARSE] ✓ Strike price from outcomes: $${price}`);
      return price;
    }

    // Try description field
    if (market.description) {
      const descMatch = market.description.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
      if (descMatch) {
        const price = parseFloat(descMatch[1].replace(/,/g, ''));
        console.log(`[PARSE] ✓ Strike price from description: $${price}`);
        return price;
      }
    }

    // Try groupItemTitle field (some markets have this)
    if (market.groupItemTitle) {
      const groupMatch = market.groupItemTitle.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
      if (groupMatch) {
        const price = parseFloat(groupMatch[1].replace(/,/g, ''));
        console.log(`[PARSE] ✓ Strike price from groupItemTitle: $${price}`);
        return price;
      }
    }
  }

  console.log(`[PARSE] ✗ Could not find strike price`);
  return null;
}

// Get active 15-minute crypto markets
app.get('/api/markets/crypto-15m', async (req, res) => {
  try {
    const markets = [];
    // Allow filtering by asset via query param (e.g., ?assets=BTC or ?assets=BTC,ETH)
    const assetParam = req.query.assets;
    const defaultAssets = ['BTC', 'ETH', 'SOL', 'XRP'];
    const assets = assetParam
      ? assetParam.split(',').map(a => a.trim().toUpperCase()).filter(a => defaultAssets.includes(a))
      : defaultAssets;

    console.log(`[API] Filtering markets for assets: ${assets.join(', ')}`);

    // Calculate current 15-minute window
    const nowTs = Math.floor(Date.now() / 1000);
    const baseTs = Math.floor(nowTs / 900) * 900;

    console.log(`[API] Searching for 15-min markets, current window: ${baseTs} (${new Date(baseTs * 1000).toISOString()})`);

    for (const asset of assets) {
      // Only try current window slug (not future windows)
      const slug = `${asset.toLowerCase()}-updown-15m-${baseTs}`;

      try {
        const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
        if (!response.ok) continue;

        const data = await response.json();
        const marketList = Array.isArray(data) ? data : [data].filter(Boolean);

        for (const m of marketList) {
          if (m && m.active && !m.closed) {
            // Parse token IDs
            let yesTokenId = '';
            let noTokenId = '';

            if (m.clobTokenIds) {
              const tokenIds = typeof m.clobTokenIds === 'string'
                ? JSON.parse(m.clobTokenIds)
                : m.clobTokenIds;
              if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
                yesTokenId = tokenIds[0];
                noTokenId = tokenIds[1];
              }
            }

            if (!yesTokenId || !noTokenId) continue;

            // Parse end time
            const endDate = m.endDate || m.end_date;
            let endTime = new Date((baseTs + 900) * 1000);
            if (endDate) {
              endTime = new Date(typeof endDate === 'string' ? endDate : endDate * 1000);
            }

            // Parse start time
            const startTime = parseStartTime(slug, endTime);

            // Only include if market is CURRENTLY ACTIVE (started AND not ended)
            if (isMarketActive(startTime, endTime)) {
              const strikePrice = parseStrikePrice(m.question, m);
              markets.push({
                conditionId: m.conditionId || m.condition_id,
                questionId: m.questionId || '',
                yesTokenId,
                noTokenId,
                question: m.question || '',
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
                asset: asset.toUpperCase(),
                slug,
                strikePrice,
              });
              console.log(`[API] Found active: ${asset} - ${slug} (strike: $${strikePrice}, ends ${endTime.toISOString()})`);
            } else {
              console.log(`[API] Skipping ${slug} - not active (start: ${startTime.toISOString()}, end: ${endTime.toISOString()})`);
            }
          }
        }
      } catch (err) {
        // Slug not found, continue
      }
    }

    // If no 15-min markets, try broader search
    if (markets.length === 0) {
      console.log('[API] No slug matches, trying broad search...');
      try {
        const response = await fetch(`${GAMMA_API}/markets?active=true&closed=false&limit=200`);
        if (response.ok) {
          const allMarkets = await response.json();

          for (const m of (Array.isArray(allMarkets) ? allMarkets : [])) {
            const question = (m.question || '').toLowerCase();
            const slug = (m.slug || '').toLowerCase();

            const is15Min = slug.includes('15m') ||
                           slug.includes('updown') ||
                           question.includes('15 minute');

            const isCrypto = question.includes('bitcoin') ||
                            question.includes('btc') ||
                            question.includes('ethereum') ||
                            question.includes('eth') ||
                            question.includes('solana') ||
                            question.includes('sol') ||
                            question.includes('ripple') ||
                            question.includes('xrp') ||
                            slug.includes('btc') ||
                            slug.includes('eth') ||
                            slug.includes('sol') ||
                            slug.includes('xrp');

            if (is15Min && isCrypto && m.active && !m.closed) {
              let yesTokenId = '';
              let noTokenId = '';

              if (m.clobTokenIds) {
                try {
                  const tokenIds = typeof m.clobTokenIds === 'string'
                    ? JSON.parse(m.clobTokenIds)
                    : m.clobTokenIds;
                  if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
                    yesTokenId = tokenIds[0];
                    noTokenId = tokenIds[1];
                  }
                } catch (e) {}
              }

              if (!yesTokenId || !noTokenId) continue;

              let asset = 'CRYPTO';
              if (question.includes('bitcoin') || slug.includes('btc')) asset = 'BTC';
              else if (question.includes('ethereum') || slug.includes('eth')) asset = 'ETH';
              else if (question.includes('solana') || slug.includes('sol')) asset = 'SOL';
              else if (question.includes('ripple') || question.includes('xrp') || slug.includes('xrp')) asset = 'XRP';

              const endDate = m.endDate || m.end_date;
              const endTime = endDate
                ? new Date(typeof endDate === 'string' ? endDate : endDate * 1000)
                : new Date(Date.now() + 15 * 60 * 1000);

              // Parse start time
              const startTime = parseStartTime(m.slug, endTime);

              // Only include if market is CURRENTLY ACTIVE
              if (isMarketActive(startTime, endTime)) {
                // Dedupe by conditionId
                if (!markets.find(x => x.conditionId === (m.conditionId || m.condition_id))) {
                  const strikePrice = parseStrikePrice(m.question, m);
                  markets.push({
                    conditionId: m.conditionId || m.condition_id,
                    questionId: m.questionId || '',
                    yesTokenId,
                    noTokenId,
                    question: m.question || '',
                    startTime: startTime.toISOString(),
                    endTime: endTime.toISOString(),
                    asset,
                    slug: m.slug || '',
                    strikePrice,
                  });
                  console.log(`[API] Found via search: ${asset} - ${m.question?.slice(0, 40)}`);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('[API] Broad search failed:', err.message);
      }
    }

    console.log(`[API] Returning ${markets.length} active markets (filtered out upcoming)`);

    // Register token -> market mapping for price history storage
    for (const m of markets) {
      tokenToMarket.set(m.yesTokenId, { marketId: m.conditionId, side: 'YES' });
      tokenToMarket.set(m.noTokenId, { marketId: m.conditionId, side: 'NO' });
    }

    res.json(markets);
  } catch (error) {
    console.error('[API] Error fetching markets:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get hourly crypto markets
app.get('/api/markets/crypto-hourly', async (req, res) => {
  try {
    const markets = [];

    const response = await fetch(`${GAMMA_API}/events?active=true&closed=false&limit=50`);
    if (!response.ok) {
      return res.json([]);
    }

    const events = await response.json();

    for (const event of (Array.isArray(events) ? events : [])) {
      const eventSlug = (event.slug || '').toLowerCase();

      if (eventSlug.includes('up-or-down') || eventSlug.includes('updown')) {
        for (const m of (event.markets || [])) {
          if (m && m.active && !m.closed) {
            let yesTokenId = '';
            let noTokenId = '';

            if (m.clobTokenIds) {
              try {
                const tokenIds = typeof m.clobTokenIds === 'string'
                  ? JSON.parse(m.clobTokenIds)
                  : m.clobTokenIds;
                if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
                  yesTokenId = tokenIds[0];
                  noTokenId = tokenIds[1];
                }
              } catch (e) {}
            }

            if (!yesTokenId || !noTokenId) continue;

            let asset = 'CRYPTO';
            if (eventSlug.includes('bitcoin')) asset = 'BTC';
            else if (eventSlug.includes('ethereum')) asset = 'ETH';

            const endDate = m.endDate || m.end_date;
            const endTime = endDate
              ? new Date(typeof endDate === 'string' ? endDate : endDate * 1000)
              : new Date(Date.now() + 60 * 60 * 1000);

            // For hourly markets, start time is 1 hour before end
            const startTime = new Date(endTime.getTime() - 60 * 60 * 1000);

            // Only include if market is CURRENTLY ACTIVE
            if (isMarketActive(startTime, endTime)) {
              markets.push({
                conditionId: m.conditionId || m.id,
                questionId: m.questionId || '',
                yesTokenId,
                noTokenId,
                question: m.question || '',
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
                asset,
                slug: eventSlug,
              });
            }
          }
        }
      }
    }

    console.log(`[API] Returning ${markets.length} active hourly markets`);

    // Register token -> market mapping for price history storage
    for (const m of markets) {
      tokenToMarket.set(m.yesTokenId, { marketId: m.conditionId, side: 'YES' });
      tokenToMarket.set(m.noTokenId, { marketId: m.conditionId, side: 'NO' });
    }

    res.json(markets);
  } catch (error) {
    console.error('[API] Error fetching hourly markets:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// CRYPTO PRICE ENDPOINTS
// ============================================================================

// Cache for crypto prices (to avoid hammering external APIs)
const cryptoPriceCache = {
  prices: {},
  lastFetch: 0,
  TTL: 10000, // 10 second cache
};

// Get live crypto prices from CoinGecko (free, no API key needed)
app.get('/api/crypto-prices', async (req, res) => {
  try {
    const now = Date.now();

    // Return cached if fresh
    if (now - cryptoPriceCache.lastFetch < cryptoPriceCache.TTL) {
      return res.json(cryptoPriceCache.prices);
    }

    // Fetch from CoinGecko
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple&vs_currencies=usd&include_24hr_change=true'
    );

    if (!response.ok) {
      // Return cached on error
      if (Object.keys(cryptoPriceCache.prices).length > 0) {
        return res.json(cryptoPriceCache.prices);
      }
      throw new Error('CoinGecko API error');
    }

    const data = await response.json();

    const prices = {
      BTC: { price: data.bitcoin?.usd || 0, change24h: data.bitcoin?.usd_24h_change || 0 },
      ETH: { price: data.ethereum?.usd || 0, change24h: data.ethereum?.usd_24h_change || 0 },
      SOL: { price: data.solana?.usd || 0, change24h: data.solana?.usd_24h_change || 0 },
      XRP: { price: data.ripple?.usd || 0, change24h: data.ripple?.usd_24h_change || 0 },
      timestamp: now,
    };

    // Update cache
    cryptoPriceCache.prices = prices;
    cryptoPriceCache.lastFetch = now;

    res.json(prices);
  } catch (error) {
    console.error('[API] Error fetching crypto prices:', error.message);
    // Return cached or zeros
    res.json(cryptoPriceCache.prices || { BTC: { price: 0 }, ETH: { price: 0 }, SOL: { price: 0 } });
  }
});

// ============================================================================
// PRICE ENDPOINTS (using official CLOB client)
// ============================================================================

// Get order book for a token
app.get('/api/book/:tokenId', async (req, res) => {
  try {
    const { tokenId } = req.params;
    const book = await clobClient.getOrderBook(tokenId);
    res.json(book);
  } catch (error) {
    console.error('[API] Error fetching order book:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get price for a market (convenience endpoint)
app.get('/api/price/:yesTokenId/:noTokenId', async (req, res) => {
  try {
    const { yesTokenId, noTokenId } = req.params;

    const [yesBook, noBook] = await Promise.all([
      clobClient.getOrderBook(yesTokenId),
      clobClient.getOrderBook(noTokenId),
    ]);

    // Best ask = lowest ask = what you pay to buy
    const yesAsk = yesBook.asks?.length > 0
      ? Math.min(...yesBook.asks.map(a => parseFloat(a.price)))
      : 0.5;
    const noAsk = noBook.asks?.length > 0
      ? Math.min(...noBook.asks.map(a => parseFloat(a.price)))
      : 0.5;

    // Best bid = highest bid
    const yesBid = yesBook.bids?.length > 0
      ? Math.max(...yesBook.bids.map(b => parseFloat(b.price)))
      : 0;
    const noBid = noBook.bids?.length > 0
      ? Math.max(...noBook.bids.map(b => parseFloat(b.price)))
      : 0;

    // Liquidity = sum of top 10 bid levels by price (sorted descending)
    // CLOB API doesn't guarantee sort order, so we sort first
    const yesBids = (yesBook.bids || [])
      .map(b => ({ size: parseFloat(b.size), price: parseFloat(b.price) }))
      .sort((a, b) => b.price - a.price)
      .slice(0, 10);
    const yesLiquidity = yesBids.reduce((sum, b) => sum + b.size * b.price, 0);

    const noBids = (noBook.bids || [])
      .map(b => ({ size: parseFloat(b.size), price: parseFloat(b.price) }))
      .sort((a, b) => b.price - a.price)
      .slice(0, 10);
    const noLiquidity = noBids.reduce((sum, b) => sum + b.size * b.price, 0);

    const priceData = {
      timestamp: Date.now(),
      yesPrice: yesAsk,
      noPrice: noAsk,
      yesBid,
      noBid,
      yesLiquidity,
      noLiquidity,
    };

    // Store in price history (use a combined key for the market)
    // The marketId can be derived from the request or passed as query param
    const marketId = req.query.marketId;
    if (marketId) {
      priceHistory.addPriceTick(marketId, priceData);
    }

    res.json(priceData);
  } catch (error) {
    console.error('[API] Error fetching price:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get midpoint price (simple)
app.get('/api/midpoint/:tokenId', async (req, res) => {
  try {
    const { tokenId } = req.params;
    const midpoint = await clobClient.getMidpoint(tokenId);
    res.json({ tokenId, midpoint: parseFloat(midpoint) });
  } catch (error) {
    console.error('[API] Error fetching midpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get spread
app.get('/api/spread/:tokenId', async (req, res) => {
  try {
    const { tokenId } = req.params;
    const spread = await clobClient.getSpread(tokenId);
    res.json({ tokenId, spread: parseFloat(spread) });
  } catch (error) {
    console.error('[API] Error fetching spread:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// PRICE HISTORY ENDPOINTS
// ============================================================================

// Get price history for a market
app.get('/api/price-history/:marketId', (req, res) => {
  const { marketId } = req.params;
  const history = priceHistory.getPriceHistory(marketId);
  res.json(history);
});

// Get all price histories (summary)
app.get('/api/price-history', (req, res) => {
  const histories = priceHistory.getAllPriceHistories();
  res.json({ histories, count: histories.length });
});

// Clear price history for a market
app.delete('/api/price-history/:marketId', (req, res) => {
  const { marketId } = req.params;
  priceHistory.clearHistory(marketId);
  res.json({ success: true, marketId });
});

// Force save all price histories
app.post('/api/price-history/save', (req, res) => {
  priceHistory.saveAll();
  res.json({ success: true, timestamp: Date.now() });
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    polymarketWs: polymarketWsConnected ? 'connected' : 'disconnected',
    polymarketWsState: polymarketWs?.readyState,
    activeSubscriptions: subscriptions.size,
    pendingSubscriptions: pendingSubscriptions.size,
    subscribedTokens: Array.from(subscriptions.keys()).map(t => t.slice(0, 12) + '...'),
    pendingTokens: Array.from(pendingSubscriptions).map(t => t.slice(0, 12) + '...'),
  });
});

// Force reconnect to Polymarket WebSocket
app.post('/api/reconnect', (req, res) => {
  console.log('[API] Force reconnect requested');
  connectToPolymarket();
  res.json({ status: 'reconnecting' });
});

// Debug endpoint - fetch market via CLOB client
app.get('/api/debug/clob-market/:conditionId', async (req, res) => {
  try {
    const { conditionId } = req.params;
    console.log(`[DEBUG] Fetching market via CLOB client: ${conditionId}`);

    const market = await clobClient.getMarket(conditionId);
    console.log(`[DEBUG] CLOB market data:`, JSON.stringify(market, null, 2));

    res.json({
      conditionId,
      market,
      allFields: market ? Object.keys(market) : [],
    });
  } catch (error) {
    console.error('[DEBUG] CLOB market error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint - list all markets via CLOB client
app.get('/api/debug/clob-markets', async (req, res) => {
  try {
    console.log(`[DEBUG] Fetching all markets via CLOB client...`);

    // Try different methods
    const results = {};

    try {
      const markets = await clobClient.getMarkets();
      results.markets = markets?.slice(0, 5); // First 5 for debugging
      results.marketsCount = markets?.length;
      if (markets?.length > 0) {
        results.sampleMarketFields = Object.keys(markets[0]);
        console.log(`[DEBUG] Sample market:`, JSON.stringify(markets[0], null, 2));
      }
    } catch (e) {
      results.marketsError = e.message;
    }

    try {
      const simplified = await clobClient.getSimplifiedMarkets();
      results.simplifiedCount = simplified?.length;
      if (simplified?.length > 0) {
        results.simplifiedSample = simplified[0];
        results.simplifiedFields = Object.keys(simplified[0]);
      }
    } catch (e) {
      results.simplifiedError = e.message;
    }

    res.json(results);
  } catch (error) {
    console.error('[DEBUG] CLOB markets error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to manually trigger market refresh
app.get('/api/debug/markets', async (req, res) => {
  try {
    const nowTs = Math.floor(Date.now() / 1000);
    const baseTs = Math.floor(nowTs / 900) * 900;

    const results = {
      currentTime: new Date().toISOString(),
      currentWindow: baseTs,
      windowStart: new Date(baseTs * 1000).toISOString(),
      windowEnd: new Date((baseTs + 900) * 1000).toISOString(),
      slugsChecked: [],
      marketsFound: [],
    };

    for (const asset of ['BTC', 'ETH', 'SOL', 'XRP']) {
      const slug = `${asset.toLowerCase()}-updown-15m-${baseTs}`;
      results.slugsChecked.push(slug);

      try {
        const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
        if (response.ok) {
          const data = await response.json();
          const marketList = Array.isArray(data) ? data : [data].filter(Boolean);
          for (const m of marketList) {
            // Log the FULL market object to see all fields
            console.log(`[DEBUG] Full market data for ${asset}:`, JSON.stringify(m, null, 2));

            results.marketsFound.push({
              asset,
              slug,
              question: m.question,
              description: m.description?.slice(0, 300),
              outcomes: m.outcomes,
              groupItemTitle: m.groupItemTitle,
              eventTitle: m.eventTitle,
              eventSlug: m.eventSlug,
              strikePrice: parseStrikePrice(m.question, m),
              active: m.active,
              closed: m.closed,
              rawFields: Object.keys(m),
              // Include ALL fields for debugging
              fullData: m,
            });
          }
        }
      } catch (e) {
        results.marketsFound.push({ asset, slug, error: e.message });
      }
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// TRADING ENDPOINTS (Live Trading)
// ============================================================================

// Initialize trading client
app.post('/api/trading/init', async (req, res) => {
  try {
    const credentials = req.body;

    // Support both naming conventions from .env
    const envCreds = {
      privateKey: process.env.POLYGON_WALLET_PRIVATE_KEY
        || process.env.POLYMARKET_PRIVATE_KEY
        || credentials.privateKey,
      funder: process.env.POLYMARKET_PROXY
        || process.env.POLYMARKET_FUNDER
        || credentials.funder,
      apiKey: process.env.POLYMARKET_API_KEY || credentials.apiKey,
      apiSecret: process.env.POLYMARKET_API_SECRET || credentials.apiSecret,
      passphrase: process.env.POLYMARKET_PASSPHRASE || credentials.passphrase,
      // Use signature type 2 (browser proxy) when POLYMARKET_PROXY is set
      signatureType: process.env.POLYMARKET_PROXY ? 2
        : parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || credentials.signatureType || '1'),
    };

    const result = await trading.initializeTradingClient(envCreds);
    console.log('[TRADING API] Client initialized:', result.address);
    res.json(result);
  } catch (error) {
    console.error('[TRADING API] Init failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Check trading status
app.get('/api/trading/status', (req, res) => {
  res.json({
    enabled: trading.isTradingEnabled(),
    address: trading.getWalletAddress(),
    dailyPnl: trading.getDailyPnl(),
    activePositions: trading.getActivePositions().length,
    config: trading.TRADING_CONFIG,
  });
});

// Update trading config
app.post('/api/trading/config', (req, res) => {
  try {
    const updatedConfig = trading.updateConfig(req.body);
    console.log('[TRADING API] Config updated:', req.body);
    res.json({ success: true, config: updatedConfig });
  } catch (error) {
    console.error('[TRADING API] Config update failed:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// Get balance
app.get('/api/trading/balance', async (req, res) => {
  try {
    if (!trading.isTradingEnabled()) {
      return res.status(400).json({ error: 'Trading not initialized' });
    }
    const balance = await trading.getBalance();
    res.json({ balance, timestamp: Date.now() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get token balance
app.get('/api/trading/token-balance/:tokenId', async (req, res) => {
  try {
    if (!trading.isTradingEnabled()) {
      return res.status(400).json({ error: 'Trading not initialized' });
    }
    const balance = await trading.getTokenBalance(req.params.tokenId);
    res.json({ tokenId: req.params.tokenId, balance, timestamp: Date.now() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get open orders
app.get('/api/trading/orders', async (req, res) => {
  try {
    if (!trading.isTradingEnabled()) {
      return res.status(400).json({ error: 'Trading not initialized' });
    }
    const orders = await trading.getOpenOrders();
    res.json({ orders, count: orders.length, timestamp: Date.now() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Place limit order
app.post('/api/trading/order/limit', async (req, res) => {
  try {
    if (!trading.isTradingEnabled()) {
      return res.status(400).json({ error: 'Trading not initialized' });
    }
    const { tokenId, side, price, size, tickSize, negRisk } = req.body;
    const result = await trading.placeLimitOrder({ tokenId, side, price, size, tickSize, negRisk });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Place market order
app.post('/api/trading/order/market', async (req, res) => {
  try {
    if (!trading.isTradingEnabled()) {
      return res.status(400).json({ error: 'Trading not initialized' });
    }
    const { tokenId, side, amount, tickSize } = req.body;
    const result = await trading.placeMarketOrder({ tokenId, side, amount, tickSize });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Place dual-entry orders
app.post('/api/trading/order/dual-entry', async (req, res) => {
  try {
    if (!trading.isTradingEnabled()) {
      return res.status(400).json({ error: 'Trading not initialized' });
    }
    const { yesTokenId, noTokenId, marketId, tickSize, negRisk } = req.body;
    const result = await trading.placeDualEntryOrders({ yesTokenId, noTokenId, marketId, tickSize, negRisk });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel order
app.delete('/api/trading/order/:orderId', async (req, res) => {
  try {
    if (!trading.isTradingEnabled()) {
      return res.status(400).json({ error: 'Trading not initialized' });
    }
    const result = await trading.cancelOrder(req.params.orderId);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel all orders
app.delete('/api/trading/orders', async (req, res) => {
  try {
    if (!trading.isTradingEnabled()) {
      return res.status(400).json({ error: 'Trading not initialized' });
    }
    const cancelled = await trading.cancelAllOrders();
    res.json({ success: true, cancelled });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get active positions
app.get('/api/trading/positions', (req, res) => {
  res.json({
    positions: trading.getActivePositions(),
    dailyPnl: trading.getDailyPnl(),
    timestamp: Date.now(),
  });
});

// Check order fills for a market
app.get('/api/trading/fills/:marketId', async (req, res) => {
  try {
    if (!trading.isTradingEnabled()) {
      return res.status(400).json({ error: 'Trading not initialized' });
    }
    const position = await trading.checkOrderFills(req.params.marketId);
    res.json({ position, timestamp: Date.now() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Exit position
app.post('/api/trading/exit', async (req, res) => {
  try {
    if (!trading.isTradingEnabled()) {
      return res.status(400).json({ error: 'Trading not initialized' });
    }
    const { tokenId, shares, reason } = req.body;
    const result = await trading.exitPosition({ tokenId, shares, reason });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// CONFIG & RESTART ENDPOINTS
// ============================================================================

// Store current config (in-memory, frontend is source of truth via localStorage)
let currentConfig = null;

// Get config
app.get('/api/config', (req, res) => {
  res.json(currentConfig || { message: 'No config synced yet' });
});

// Sync config from frontend
app.post('/api/config', (req, res) => {
  currentConfig = req.body;
  console.log('[CONFIG] Config synced from frontend:', {
    momentum: {
      takeProfitEnabled: currentConfig?.momentum?.takeProfitEnabled,
      takeProfitThreshold: currentConfig?.momentum?.takeProfitThreshold,
      maxHedges: currentConfig?.momentum?.maxHedges,
    },
    dualEntry: {
      loserDropPct: currentConfig?.dualEntry?.loserDropPct,
      winnerGainPct: currentConfig?.dualEntry?.winnerGainPct,
    },
    system: {
      paperTrading: currentConfig?.system?.paperTrading,
      autoRestartOnNewMarket: currentConfig?.system?.autoRestartOnNewMarket,
    },
  });
  res.json({ success: true, timestamp: Date.now() });
});

// Restart sessions (clears state, frontend will re-initialize)
app.post('/api/restart', (req, res) => {
  console.log('[RESTART] Session restart requested');

  // Clear all subscriptions
  for (const tokenId of subscriptions.keys()) {
    subscriptions.delete(tokenId);
  }
  pendingSubscriptions.clear();

  // Notify all connected clients to reinitialize
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'restart', timestamp: Date.now() }));
    }
  });

  // Reconnect to Polymarket
  connectToPolymarket();

  res.json({ success: true, message: 'Sessions restarted', timestamp: Date.now() });
});

// ============================================================================
// AUDIT LOG ENDPOINTS
// ============================================================================

// Log an audit entry
app.post('/api/audit/log', (req, res) => {
  const entry = auditStorage.logEntry(req.body);
  if (entry) {
    res.json({ success: true, entry });
  } else {
    res.status(500).json({ success: false, error: 'Failed to log entry' });
  }
});

// Get sessions list
app.get('/api/audit/sessions', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  const sessions = auditStorage.getSessions(limit, offset);
  res.json({ sessions, count: sessions.length });
});

// Get single session
app.get('/api/audit/sessions/:sessionId', (req, res) => {
  const session = auditStorage.getSession(req.params.sessionId);
  if (session) {
    res.json(session);
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Get session entries
app.get('/api/audit/sessions/:sessionId/entries', (req, res) => {
  const limit = parseInt(req.query.limit) || 500;
  const entries = auditStorage.getSessionEntries(req.params.sessionId, limit);
  res.json({ entries, count: entries.length });
});

// Export session to markdown (for AI review)
app.get('/api/audit/sessions/:sessionId/markdown', (req, res) => {
  const markdown = auditStorage.exportSessionToMarkdown(req.params.sessionId);
  res.type('text/markdown').send(markdown);
});

// Save AI analysis for session
app.post('/api/audit/sessions/:sessionId/analysis', (req, res) => {
  const success = auditStorage.saveAiAnalysis(req.params.sessionId, req.body);
  res.json({ success });
});

// Get entries with filters
app.get('/api/audit/entries', (req, res) => {
  const filters = {
    sessionId: req.query.sessionId,
    asset: req.query.asset,
    strategy: req.query.strategy,
    eventTypes: req.query.eventTypes?.split(','),
    since: req.query.since ? parseInt(req.query.since) : undefined,
    limit: parseInt(req.query.limit) || 500,
  };
  const entries = auditStorage.getEntries(filters);
  res.json({ entries, count: entries.length });
});

// Get audit stats
app.get('/api/audit/stats', (req, res) => {
  const stats = auditStorage.getStats();
  res.json(stats);
});

// Get daily stats (persisted across restarts)
app.get('/api/audit/daily-stats', (req, res) => {
  const stats = auditStorage.getDailyStats();
  res.json(stats);
});

// Cleanup old data
app.post('/api/audit/cleanup', (req, res) => {
  const days = parseInt(req.body.days) || 7;
  auditStorage.cleanup(days);
  res.json({ success: true, daysKept: days });
});

// ============================================================================
// CONFIG PRESETS API (Per-Strategy)
// ============================================================================

// Get all presets (across all strategies)
app.get('/api/presets', (req, res) => {
  try {
    const presets = configPresets.getAllPresets();
    res.json(presets);
  } catch (error) {
    console.error('[PRESETS] Error getting presets:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all defaults (one per strategy)
app.get('/api/presets/defaults', (req, res) => {
  try {
    const defaults = configPresets.getAllDefaults();
    res.json(defaults);
  } catch (error) {
    console.error('[PRESETS] Error getting defaults:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get presets for a specific strategy
app.get('/api/presets/strategy/:strategy', (req, res) => {
  try {
    const presets = configPresets.getPresetsByStrategy(req.params.strategy);
    res.json(presets);
  } catch (error) {
    console.error('[PRESETS] Error getting presets:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get default preset for a strategy
app.get('/api/presets/strategy/:strategy/default', (req, res) => {
  try {
    const preset = configPresets.getDefaultPreset(req.params.strategy);
    if (preset) {
      res.json(preset);
    } else {
      res.status(404).json({ error: 'No default preset for this strategy' });
    }
  } catch (error) {
    console.error('[PRESETS] Error getting default preset:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get preset by strategy and name
app.get('/api/presets/strategy/:strategy/:name', (req, res) => {
  try {
    const preset = configPresets.getPreset(req.params.strategy, req.params.name);
    if (preset) {
      res.json(preset);
    } else {
      res.status(404).json({ error: 'Preset not found' });
    }
  } catch (error) {
    console.error('[PRESETS] Error getting preset:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save or update preset for a strategy
app.post('/api/presets/strategy/:strategy', (req, res) => {
  try {
    const strategy = req.params.strategy;
    const { name, config, isDefault } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!config) {
      return res.status(400).json({ error: 'Config is required' });
    }
    const preset = configPresets.savePreset({
      strategy,
      name,
      config,
      isDefault: isDefault ?? false,
    });
    console.log(`[PRESETS] Saved ${strategy}/${name}`);
    res.json(preset);
  } catch (error) {
    console.error('[PRESETS] Error saving preset:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set preset as default for a strategy
app.put('/api/presets/strategy/:strategy/:name/default', (req, res) => {
  try {
    const preset = configPresets.setAsDefault(req.params.strategy, req.params.name);
    if (preset) {
      console.log(`[PRESETS] Set default: ${req.params.strategy}/${req.params.name}`);
      res.json(preset);
    } else {
      res.status(404).json({ error: 'Preset not found' });
    }
  } catch (error) {
    console.error('[PRESETS] Error setting default:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clear default for a strategy
app.delete('/api/presets/strategy/:strategy/default', (req, res) => {
  try {
    configPresets.clearDefault(req.params.strategy);
    console.log(`[PRESETS] Cleared default for ${req.params.strategy}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[PRESETS] Error clearing default:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete preset
app.delete('/api/presets/strategy/:strategy/:name', (req, res) => {
  try {
    configPresets.deletePreset(req.params.strategy, req.params.name);
    console.log(`[PRESETS] Deleted ${req.params.strategy}/${req.params.name}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[PRESETS] Error deleting preset:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// MULTI-OUTCOME ARBITRAGE SCANNER (Frank-Wolfe / NegRisk Markets)
// ============================================================================
// Based on "Arbitrage-Free Combinatorial Market Making via Integer Programming"
// Scans multi-outcome events where sum of outcome probabilities should = 1
// Type 1 mispricing: sum ≠ 1 creates guaranteed arbitrage opportunity

// Scanner config
const arbitrageConfig = {
  minMispricing: 0.02,     // 2% minimum mispricing to consider (after fees)
  feeRate: 0.02,           // 2% fee per trade on Polymarket
  minLiquidity: 1,         // Minimum $1 liquidity per outcome (lowered for analysis)
  maxEvents: 100,          // Max events to scan
  alphaExtraction: 0.9,    // Stop when 90% of profit extractable (from research)
};

// State
let lastArbitrageScan = {
  events: [],
  opportunities: [],
  totalEvents: 0,
  multiOutcomeEvents: 0,
  withMispricing: 0,
  qualifyingOpportunities: 0,
  scanTime: 0,
  timestamp: Date.now(),
  errors: ['Initializing scanner...'],
  scanType: 'multi-outcome',
};
let arbitrageScanInProgress = false;

// Multi-outcome event storage
const multiOutcomeEvents = new Map(); // eventId -> event analysis

/**
 * Fetch all active events (not markets) from Polymarket
 * Events contain multiple markets/outcomes
 */
async function fetchActiveEvents() {
  const events = [];
  let offset = 0;
  const limit = 50;
  let networkFailed = false;

  while (events.length < arbitrageConfig.maxEvents) {
    try {
      const url = `${GAMMA_API}/events?active=true&closed=false&limit=${limit}&offset=${offset}`;
      console.log(`[ARB-FW] Fetching events: offset=${offset}`);

      // Add 10 second timeout to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; ArbitrageBot/1.0)',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.log(`[ARB-FW] API returned ${response.status}, stopping fetch`);
        break;
      }
      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) break;

      events.push(...data);
      offset += limit;

      await new Promise(r => setTimeout(r, 50));
    } catch (error) {
      console.error('[ARB-FW] Failed to fetch events:', error.message);
      networkFailed = true;
      break;
    }
  }

  // If no events fetched and mock mode is enabled, use mock data
  if (events.length === 0 && (USE_MOCK_DATA || networkFailed)) {
    console.log('[ARB-FW] ⚠️ Network unavailable - using MOCK DATA for testing');
    const mockEvents = getMockEvents();
    console.log(`[ARB-FW] Loaded ${mockEvents.length} mock events`);
    return mockEvents;
  }

  console.log(`[ARB-FW] Total events fetched: ${events.length}`);
  return events;
}

/**
 * Extract token IDs from a market
 */
function extractTokenIds(market) {
  let yesTokenId = '';
  let noTokenId = '';

  if (market.clobTokenIds) {
    try {
      const tokenIds = typeof market.clobTokenIds === 'string'
        ? JSON.parse(market.clobTokenIds)
        : market.clobTokenIds;
      if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
        yesTokenId = tokenIds[0];
        noTokenId = tokenIds[1];
      }
    } catch (e) {}
  }

  return { yesTokenId, noTokenId };
}

/**
 * Helper: wrap a promise with a timeout to prevent hanging
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
}

/**
 * Get order book prices for a token
 */
async function getOutcomePrices(tokenId) {
  try {
    // Add 5 second timeout to prevent hanging
    const book = await withTimeout(clobClient.getOrderBook(tokenId), 5000);
    const asks = book?.asks || [];
    const bids = book?.bids || [];

    return {
      bestAsk: asks.length > 0 ? Math.min(...asks.map(a => parseFloat(a.price))) : 0.5,
      bestBid: bids.length > 0 ? Math.max(...bids.map(b => parseFloat(b.price))) : 0.5,
      liquidity: bids.slice(0, 5).reduce((sum, b) => sum + parseFloat(b.size) * parseFloat(b.price), 0),
    };
  } catch (error) {
    // Timeout or other error - return defaults
    return { bestAsk: 0.5, bestBid: 0.5, liquidity: 0 };
  }
}

/**
 * Detect if outcomes are temporal deadlines (e.g., "by March 31" vs "by December 31")
 * These are NOT mutually exclusive and should NOT be treated as sum=1 arbitrage
 */
function isTemporalDeadlineEvent(eventData, markets) {
  const eventTitle = (eventData?.title || '').toLowerCase();

  // STRONG SIGNAL: Event title contains "by...?" pattern
  // e.g., "Will Russia capture Lyman by...?" or "Will X happen by...?"
  if (/\bby\s*\.{2,}\??$/i.test(eventTitle) || /\bby\s+when/i.test(eventTitle)) {
    return true;
  }

  // STRONG SIGNAL: Event title ends with "by [date]?" pattern
  // e.g., "Will X happen by March 2025?"
  if (/by\s+(january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|\d{4})/i.test(eventTitle)) {
    return true;
  }

  const datePatterns = [
    // "by March", "by February 28", etc.
    /by\s+(january|february|march|april|may|june|july|august|september|october|november|december)/i,
    /by\s+(Q[1-4])/i,
    /by\s+end\s+of\s+\d{4}/i,
    /by\s+\d{4}/i,
    // "March 31, 2025" - full date with year
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s*\d{4}/i,
    // "February 28", "March 31" - month + day without year (CRITICAL for Lyman-style markets)
    /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}$/i,
    // Looser match: contains "Month Day" anywhere (trimmed)
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:\s|$|,)/i,
  ];

  let temporalCount = 0;
  for (const market of markets) {
    const title = (market.groupItemTitle || market.question || '').trim();
    for (const pattern of datePatterns) {
      if (pattern.test(title)) {
        temporalCount++;
        break;
      }
    }
  }

  // If most outcomes have date patterns, it's likely a temporal deadline event
  return temporalCount >= markets.length * 0.5;
}

/**
 * Detect if this is an "independent events" market where outcomes are unrelated
 * e.g., "What will happen before X?" with outcomes like [Album release, War, Election, etc.]
 * These are NOT mutually exclusive - multiple (or all, or none) can happen
 */
function isIndependentEventsMarket(eventData, markets) {
  const title = (eventData.title || '').toLowerCase();

  // Pattern 1: "What will happen" style questions
  const independentPatterns = [
    /what will happen/i,
    /what happens/i,
    /which.*will happen/i,
    /things that will/i,
    /events.*before/i,
    /predictions for/i,
    /will any of/i,
    /how many.*will/i,
  ];

  for (const pattern of independentPatterns) {
    if (pattern.test(title)) {
      return true;
    }
  }

  // Pattern 2: Outcomes are completely unrelated topics
  // Check if outcomes span multiple unrelated categories
  const categories = new Set();
  const categoryKeywords = {
    music: ['album', 'song', 'release', 'drake', 'rihanna', 'carti', 'music', 'artist'],
    politics: ['president', 'election', 'trump', 'biden', 'congress', 'vote', 'political'],
    war: ['war', 'invasion', 'military', 'ceasefire', 'russia', 'ukraine', 'china', 'taiwan'],
    tech: ['gpt', 'ai', 'released', 'launch', 'apple', 'google', 'tesla'],
    crypto: ['bitcoin', 'btc', 'eth', 'crypto', '$1m', '$100k'],
    religion: ['jesus', 'christ', 'god', 'religious'],
    sports: ['championship', 'world cup', 'super bowl', 'nba', 'nfl'],
  };

  for (const market of markets) {
    const outcomeTitle = (market.groupItemTitle || market.question || '').toLowerCase();
    for (const [category, keywords] of Object.entries(categoryKeywords)) {
      if (keywords.some(kw => outcomeTitle.includes(kw))) {
        categories.add(category);
        break;
      }
    }
  }

  // If outcomes span 3+ unrelated categories, it's likely independent events
  if (categories.size >= 3) {
    return true;
  }

  return false;
}

/**
 * Detect if this is a cumulative/threshold market where outcomes are NOT mutually exclusive
 * e.g., "Will BTC reach $100k/$125k/$150k?" - reaching $150k means $100k and $125k are also true
 * e.g., "Total wins: 0/1/2/3/4/5/6" - VALID (exactly one total)
 * e.g., "Reach X by date" - if prices are cumulative (higher price = superset of lower) = INVALID
 */
function isCumulativeThresholdMarket(eventData, markets) {
  const title = (eventData.title || '').toLowerCase();

  // Pattern 1: "Will X reach/hit/exceed $Y" with multiple price thresholds
  // Check if outcomes contain ascending numeric thresholds
  const thresholdPatterns = [
    /reach\s*\$?\d/i,
    /hit\s*\$?\d/i,
    /exceed\s*\$?\d/i,
    /above\s*\$?\d/i,
    /over\s*\$?\d/i,
    /\$\d+k?\+/i,  // "$100k+" style
  ];

  if (thresholdPatterns.some(p => p.test(title))) {
    // Extract numeric values from outcome titles
    const values = [];
    for (const market of markets) {
      const outcomeTitle = (market.groupItemTitle || market.question || '').toLowerCase();
      // Match prices like $100k, $125,000, 100000, etc.
      const matches = outcomeTitle.match(/\$?([\d,]+)k?/g);
      if (matches) {
        for (const m of matches) {
          const num = parseFloat(m.replace(/[$,k]/gi, '')) * (m.toLowerCase().includes('k') ? 1000 : 1);
          if (!isNaN(num) && num > 0) values.push(num);
        }
      }
    }

    // If we have ascending threshold values, it's cumulative
    if (values.length >= 2) {
      const sorted = [...new Set(values)].sort((a, b) => a - b);
      // Check if these look like cumulative thresholds (all different values)
      if (sorted.length >= 2) {
        return true;
      }
    }
  }

  // Pattern 2: "More than X" style outcomes
  const morePatterns = [
    /more than \d/i,
    /at least \d/i,
    /\d\+ /i,
    /\d or more/i,
  ];

  let moreCount = 0;
  for (const market of markets) {
    const outcomeTitle = (market.groupItemTitle || market.question || '').toLowerCase();
    if (morePatterns.some(p => p.test(outcomeTitle))) {
      moreCount++;
    }
  }

  // If multiple outcomes use "more than" / "at least" patterns, likely cumulative
  if (moreCount >= 2) {
    return true;
  }

  return false;
}

/**
 * Master validation: Is this a valid Type 1 arbitrage market?
 * For Type 1 to be valid, outcomes MUST be:
 * 1. Mutually exclusive (exactly one can be TRUE)
 * 2. Exhaustive (one MUST be TRUE)
 *
 * VALID examples:
 * - "Who will win the election?" (exactly one winner)
 * - "Which team wins the championship?" (exactly one champion)
 * - "What will the price be? <$50k / $50k-$100k / >$100k" (non-overlapping ranges)
 *
 * INVALID examples:
 * - "Will X happen by March/June/December?" (nested deadlines)
 * - "What will happen before Y?" with unrelated outcomes
 * - "Will X reach $100k/$150k/$200k?" (cumulative thresholds)
 */
function isValidType1ArbitrageMarket(eventData, markets) {
  // Check 1: Skip temporal deadline events
  if (isTemporalDeadlineEvent(eventData, markets)) {
    console.log(`[ARB-VALIDATE] INVALID - Temporal deadlines: ${eventData.title}`);
    return false;
  }

  // Check 2: Skip independent events markets
  if (isIndependentEventsMarket(eventData, markets)) {
    console.log(`[ARB-VALIDATE] INVALID - Independent events: ${eventData.title}`);
    return false;
  }

  // Check 3: Skip cumulative threshold markets
  if (isCumulativeThresholdMarket(eventData, markets)) {
    console.log(`[ARB-VALIDATE] INVALID - Cumulative thresholds: ${eventData.title}`);
    return false;
  }

  // Check 4: If sum of prices > 2.0, almost certainly NOT mutually exclusive
  // (Real mutually exclusive markets should hover around 1.0)
  // This catches markets where multiple outcomes can all be true

  // Check 5: Look for "Who will win" / "Which X" patterns (strong indicators of valid markets)
  const validPatterns = [
    /who will win/i,
    /which.*will win/i,
    /winner of/i,
    /next.*president/i,
    /next.*prime minister/i,
    /what place will/i,
    /what will.*finish/i,
    /where will.*finish/i,
  ];

  const title = (eventData.title || '').toLowerCase();
  const hasValidPattern = validPatterns.some(p => p.test(title));

  if (hasValidPattern) {
    console.log(`[ARB-VALIDATE] VALID - Winner/placement market: ${eventData.title}`);
    return true;
  }

  // Default: Allow markets that passed all negative checks
  // They might still be valid mutually exclusive markets
  console.log(`[ARB-VALIDATE] VALID (default) - ${eventData.title}`);
  return true;
}

/**
 * Process a multi-outcome event and calculate arbitrage using Frank-Wolfe engine
 */
async function processMultiOutcomeEvent(eventData) {
  const markets = eventData.markets || [];

  // Only interested in multi-outcome events (2+ markets)
  const activeMarkets = markets.filter(m => m.active && !m.closed);
  if (activeMarkets.length < 2) return null;

  // CRITICAL: Validate using new modular validator
  // Checks: temporal deadlines, independent events, cumulative thresholds
  const validation = validateType1Market(eventData, activeMarkets);
  if (!validation.isValid) {
    console.log(`[ARB-FW] Skipping invalid market: ${eventData.title} - ${validation.reason}`);
    return null;
  }

  // Log valid markets with their confidence level
  if (validation.confidence === 'HIGH') {
    console.log(`[ARB-FW] Valid market (HIGH confidence): ${eventData.title}`);
  }

  const outcomes = [];
  let totalYesPrice = 0;
  let minLiquidity = Infinity;

  // Fetch prices for each outcome
  for (const market of activeMarkets) {
    const { yesTokenId } = extractTokenIds(market);

    let price = 0.5;
    let liquidity = 0;

    // First try to get embedded prices from market data (works for mock data)
    if (market.outcomePrices) {
      try {
        const prices = typeof market.outcomePrices === 'string'
          ? JSON.parse(market.outcomePrices)
          : market.outcomePrices;
        if (Array.isArray(prices) && prices.length > 0) {
          price = parseFloat(prices[0]) || 0.5;  // YES price is first
          liquidity = market.volume || 1000;  // Use volume as proxy for liquidity
        }
      } catch (e) {}
    }

    // If we have a real token ID and no embedded price, try order book
    if (yesTokenId && !yesTokenId.startsWith('mock-')) {
      const priceData = await getOutcomePrices(yesTokenId);
      if (priceData.bestAsk !== 0.5 || priceData.liquidity > 0) {
        price = priceData.bestAsk;
        liquidity = priceData.liquidity;
      }
    }

    outcomes.push({
      id: market.conditionId || market.id,
      question: market.question || '',
      groupItemTitle: market.groupItemTitle || market.question,
      price,
      liquidity,
    });

    totalYesPrice += price;
    minLiquidity = Math.min(minLiquidity, liquidity);
  }

  // Post-price validation using new module
  const priceValidation = validatePriceSum(totalYesPrice, outcomes.length);
  if (!priceValidation.isValid) {
    console.log(`[ARB-FW] Skipping: ${eventData.title} - ${priceValidation.reason}`);
    return null;
  }

  // Use Frank-Wolfe engine for sophisticated analysis
  const fwEngine = new FrankWolfeEngine({
    alphaExtraction: arbitrageConfig.alphaExtraction,
    feeRate: arbitrageConfig.feeRate,
    epsilonD: arbitrageConfig.minMispricing,
  });

  const fwAnalysis = fwEngine.analyze(outcomes, eventData);

  // Build result object with Frank-Wolfe metrics
  const mispricing = totalYesPrice - 1.0;
  const absoluteMispricing = Math.abs(mispricing);

  // Determine opportunity type
  let opportunityType = 'NONE';
  if (fwAnalysis.hasArbitrage) {
    opportunityType = fwAnalysis.strategy;
  }

  // Qualification check with enhanced reasons
  const reasons = [...(fwAnalysis.reasons || [])];
  let qualifies = fwAnalysis.hasArbitrage && fwAnalysis.profitAfterFees > 0;

  if (minLiquidity < arbitrageConfig.minLiquidity) {
    reasons.push(`Insufficient liquidity: $${minLiquidity.toFixed(0)} < $${arbitrageConfig.minLiquidity} minimum`);
    qualifies = false;
  }

  // Add validation confidence to reasons
  reasons.push(`Validation: ${validation.confidence} confidence (${validation.type || 'unknown type'})`);

  if (qualifies) {
    reasons.unshift(`✓ ARBITRAGE: ${opportunityType} all ${outcomes.length} outcomes for ${(fwAnalysis.profitAfterFees * 100).toFixed(2)}% profit`);
  }

  return {
    id: eventData.id,
    slug: eventData.slug,
    title: eventData.title,
    description: eventData.description?.slice(0, 200),
    url: `https://polymarket.com/event/${eventData.slug}`,
    isNegRisk: eventData.negRisk || false,
    numOutcomes: outcomes.length,
    outcomes,
    totalYesPrice,
    mispricing,
    absoluteMispricing,
    opportunityType,
    rawProfit: fwAnalysis.rawProfit || absoluteMispricing,
    fees: fwAnalysis.fees || (outcomes.length * arbitrageConfig.feeRate * 2),
    profitAfterFees: fwAnalysis.profitAfterFees || 0,
    minLiquidity,
    qualifies,
    reasons,
    // Frank-Wolfe specific metrics
    frankWolfe: {
      bregmanDivergence: fwAnalysis.bregmanDivergence,
      guaranteedProfit: fwAnalysis.guaranteedProfit,
      extractionRate: fwAnalysis.extractionRate,
      maxPositionSize: fwAnalysis.maxPositionSize,
      expectedDollarProfit: fwAnalysis.expectedDollarProfit,
    },
    validationConfidence: validation.confidence,
    lastUpdated: Date.now(),
  };
}

/**
 * Run full arbitrage scan on multi-outcome events
 * This is the main scan function based on Frank-Wolfe arbitrage principles
 */
async function runMultiOutcomeArbitrageScan() {
  if (arbitrageScanInProgress) {
    console.log('[ARB-FW] Scan already in progress...');
    // Return last result or empty result if none exists yet
    return lastArbitrageScan || {
      events: [],
      opportunities: [],
      totalEvents: 0,
      multiOutcomeEvents: 0,
      withMispricing: 0,
      qualifyingOpportunities: 0,
      scanTime: 0,
      timestamp: Date.now(),
      errors: ['Scan in progress, please wait...'],
      scanType: 'multi-outcome',
    };
  }

  arbitrageScanInProgress = true;
  const startTime = Date.now();

  console.log('\n[ARB-FW] ════════════════════════════════════════════════════════');
  console.log('[ARB-FW] Starting MULTI-OUTCOME arbitrage scan (Frank-Wolfe)');
  console.log('[ARB-FW] Looking for NegRisk events where sum(outcomes) ≠ 1');

  const results = {
    events: [],
    opportunities: [],
    totalEvents: 0,
    multiOutcomeEvents: 0,
    withMispricing: 0,
    qualifyingOpportunities: 0,
    scanTime: 0,
    timestamp: Date.now(),
    errors: [],
    scanType: 'multi-outcome',
  };

  try {
    // Fetch events (not individual markets)
    const rawEvents = await fetchActiveEvents();
    results.totalEvents = rawEvents.length;
    console.log(`[ARB-FW] Fetched ${rawEvents.length} events`);

    // Process each event
    for (const eventData of rawEvents) {
      // Skip single-market events
      const markets = eventData.markets || [];
      if (markets.length < 2) continue;

      results.multiOutcomeEvents++;

      try {
        const analysis = await processMultiOutcomeEvent(eventData);
        if (!analysis) continue;

        // Store in cache
        multiOutcomeEvents.set(analysis.id, analysis);

        // Add to results
        results.events.push(analysis);

        if (analysis.absoluteMispricing >= 0.01) {
          results.withMispricing++;
        }

        if (analysis.qualifies) {
          results.qualifyingOpportunities++;
          results.opportunities.push(analysis);
          console.log(`[ARB-FW] 🎯 OPPORTUNITY: ${analysis.title}`);
          console.log(`[ARB-FW]    ${analysis.numOutcomes} outcomes, Sum: ${analysis.totalYesPrice.toFixed(3)}`);
          console.log(`[ARB-FW]    Mispricing: ${(analysis.mispricing * 100).toFixed(2)}%, Profit: ${(analysis.profitAfterFees * 100).toFixed(2)}%`);
        }
      } catch (e) {
        // Skip events that fail
      }

      // Rate limiting
      await new Promise(r => setTimeout(r, 30));
    }

    // Sort by profit potential
    results.events.sort((a, b) => b.absoluteMispricing - a.absoluteMispricing);
    results.opportunities.sort((a, b) => b.profitAfterFees - a.profitAfterFees);

  } catch (error) {
    results.errors.push(error.message);
    console.error('[ARB-FW] Scan error:', error.message);
  } finally {
    // ALWAYS reset the flag, even if there's an error
    arbitrageScanInProgress = false;
  }

  results.scanTime = Date.now() - startTime;

  console.log('[ARB-FW] ────────────────────────────────────────────────────────');
  console.log(`[ARB-FW] Scan complete in ${results.scanTime}ms`);
  console.log(`[ARB-FW] Total events: ${results.totalEvents}`);
  console.log(`[ARB-FW] Multi-outcome events: ${results.multiOutcomeEvents}`);
  console.log(`[ARB-FW] With mispricing (>1%): ${results.withMispricing} (${((results.withMispricing / Math.max(1, results.multiOutcomeEvents)) * 100).toFixed(1)}%)`);
  console.log(`[ARB-FW] Qualifying opportunities: ${results.qualifyingOpportunities}`);
  console.log('[ARB-FW] ════════════════════════════════════════════════════════\n');

  lastArbitrageScan = results;
  return results;
}

// ============================================================================
// ARBITRAGE API ROUTES
// ============================================================================

// Run multi-outcome arbitrage scan (Frank-Wolfe style)
app.get('/api/arbitrage/scan', async (req, res) => {
  try {
    // If scan is in progress, wait for it to complete (up to 60 seconds)
    if (arbitrageScanInProgress) {
      console.log('[ARB-API] Scan in progress, waiting...');
      let waited = 0;
      while (arbitrageScanInProgress && waited < 60000) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
      }
      // Return the updated result after waiting
      res.json(lastArbitrageScan);
      return;
    }

    const result = await runMultiOutcomeArbitrageScan();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get cached result
app.get('/api/arbitrage/result', (req, res) => {
  if (lastArbitrageScan) {
    res.json(lastArbitrageScan);
  } else {
    res.json({
      events: [],
      opportunities: [],
      totalEvents: 0,
      multiOutcomeEvents: 0,
      qualifyingOpportunities: 0,
      scanTime: 0,
      timestamp: Date.now(),
      errors: ['No scan performed yet. Call /api/arbitrage/scan first.'],
      scanType: 'multi-outcome',
    });
  }
});

// Diagnostic endpoint - shows scanner state
app.get('/api/arbitrage/status', (req, res) => {
  res.json({
    scanInProgress: arbitrageScanInProgress,
    hasCachedResult: !!lastArbitrageScan,
    cachedResultTimestamp: lastArbitrageScan?.timestamp,
    cachedEventCount: lastArbitrageScan?.events?.length || 0,
    cachedOpportunityCount: lastArbitrageScan?.opportunities?.length || 0,
    cachedErrors: lastArbitrageScan?.errors || [],
    serverTime: Date.now(),
  });
});

// Force refresh
app.post('/api/arbitrage/refresh', async (req, res) => {
  try {
    multiOutcomeEvents.clear();
    const result = await runMultiOutcomeArbitrageScan();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update arbitrage config
app.post('/api/arbitrage/config', (req, res) => {
  const { minLiquidity, minMispricing, maxEvents, feeRate, alphaExtraction } = req.body;
  if (minLiquidity !== undefined) arbitrageConfig.minLiquidity = minLiquidity;
  if (minMispricing !== undefined) arbitrageConfig.minMispricing = minMispricing;
  if (maxEvents !== undefined) arbitrageConfig.maxEvents = maxEvents;
  if (feeRate !== undefined) arbitrageConfig.feeRate = feeRate;
  if (alphaExtraction !== undefined) arbitrageConfig.alphaExtraction = alphaExtraction;
  console.log('[ARB-FW] Config updated:', arbitrageConfig);
  res.json({ success: true, config: arbitrageConfig });
});

// Get arbitrage config
app.get('/api/arbitrage/config', (req, res) => {
  res.json({
    ...arbitrageConfig,
    description: 'Multi-outcome event scanner based on Frank-Wolfe arbitrage principles',
    scanType: 'multi-outcome',
  });
});

// ============================================================================
// TYPE 2 ARBITRAGE: CROSS-MARKET DEPENDENCIES
// ============================================================================

// Cache for cross-market dependency scan results
let lastCrossMarketScan = null;

/**
 * Scan for cross-market dependencies (Type 2 arbitrage)
 * Finds logical relationships between markets:
 * - Temporal: "X by March" should have P <= "X by June"
 * - Threshold: "Price > $100" should have P <= "Price > $50"
 */
app.get('/api/arbitrage/cross-market', async (req, res) => {
  console.log('\n[ARB-TYPE2] ════════════════════════════════════════════════════');
  console.log('[ARB-TYPE2] Starting cross-market dependency scan...');

  const startTime = Date.now();

  try {
    // First, fetch all active markets
    const allMarkets = [];
    let offset = 0;
    const limit = 100;

    while (allMarkets.length < 500) {
      const url = `${GAMMA_API}/markets?active=true&closed=false&limit=${limit}&offset=${offset}`;
      console.log(`[ARB-TYPE2] Fetching markets: offset=${offset}`);

      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        },
      });

      if (!response.ok) break;
      const markets = await response.json();
      if (!Array.isArray(markets) || markets.length === 0) break;

      allMarkets.push(...markets);
      offset += limit;
      await new Promise(r => setTimeout(r, 50));
    }

    console.log(`[ARB-TYPE2] Fetched ${allMarkets.length} markets for dependency analysis`);

    // Now analyze for cross-market dependencies
    const result = await analyzeCrossMarketDependencies(allMarkets);

    result.scanTime = Date.now() - startTime;
    lastCrossMarketScan = result;

    console.log('[ARB-TYPE2] ────────────────────────────────────────────────────');
    console.log(`[ARB-TYPE2] Scan complete in ${result.scanTime}ms`);
    console.log(`[ARB-TYPE2] Temporal deps: ${result.stats.temporalDependencies}`);
    console.log(`[ARB-TYPE2] Threshold deps: ${result.stats.thresholdDependencies}`);
    console.log(`[ARB-TYPE2] Violations: ${result.stats.violations}`);
    console.log(`[ARB-TYPE2] Opportunities: ${result.stats.qualifyingOpportunities}`);
    console.log('[ARB-TYPE2] ════════════════════════════════════════════════════\n');

    res.json(result);
  } catch (error) {
    console.error('[ARB-TYPE2] Scan error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get cached cross-market result
app.get('/api/arbitrage/cross-market/result', (req, res) => {
  if (lastCrossMarketScan) {
    res.json(lastCrossMarketScan);
  } else {
    res.json({
      dependencies: [],
      opportunities: [],
      stats: {
        totalMarkets: 0,
        temporalDependencies: 0,
        thresholdDependencies: 0,
        violations: 0,
        qualifyingOpportunities: 0,
        scanTime: 0,
      },
      errors: ['No cross-market scan performed yet. Call /api/arbitrage/cross-market first.'],
      timestamp: Date.now(),
    });
  }
});

// ============================================================================
// TYPE 3 ARBITRAGE: Settlement Lag Detection
// Detects markets where outcomes are effectively determined but prices haven't locked
// ============================================================================

let lastSettlementLagScan = null;

/**
 * Scan for settlement lag opportunities (Type 3)
 * Detects markets where price should be 0 or 1 but isn't
 */
app.get('/api/arbitrage/settlement-lag', async (req, res) => {
  console.log('\n[ARB-TYPE3] ════════════════════════════════════════════════════');
  console.log('[ARB-TYPE3] Starting settlement lag scan...');

  const startTime = Date.now();

  try {
    // Fetch recently closed markets (settlement lag targets) AND active markets
    const allMarkets = [];

    // Fetch closed markets (where settlement lag matters most)
    for (const filter of ['closed=true', 'active=true']) {
      let offset = 0;
      const limit = 100;
      while (allMarkets.length < 300) {
        const url = `${GAMMA_API}/markets?${filter}&order=endDate&ascending=false&limit=${limit}&offset=${offset}`;
        console.log(`[ARB-TYPE3] Fetching markets: ${filter}, offset=${offset}`);

        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          },
        });

        if (!response.ok) break;
        const markets = await response.json();
        if (!Array.isArray(markets) || markets.length === 0) break;

        allMarkets.push(...markets);
        offset += limit;
        await new Promise(r => setTimeout(r, 50));

        // Only fetch 1 page of active markets (settlement lag is mainly about closed ones)
        if (filter === 'active=true') break;
      }
    }

    // Client-side filter: only keep markets with endDate within last 90 days
    const now = Date.now();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const recentMarkets = allMarkets.filter(m => {
      const endDate = m.endDateIso || m.endDate;
      if (!endDate) return true; // Keep markets without end dates (active ones)
      const endTime = new Date(endDate).getTime();
      return !isNaN(endTime) && (now - endTime) < ninetyDaysMs;
    });

    console.log(`[ARB-TYPE3] Fetched ${allMarkets.length} markets, ${recentMarkets.length} within last 90 days`);

    // Enrich with price data - use outcomePrices from Gamma as primary source
    for (const market of recentMarkets) {
      // Primary: Parse outcomePrices from Gamma API response
      if (market.outcomePrices) {
        try {
          const prices = typeof market.outcomePrices === 'string'
            ? JSON.parse(market.outcomePrices) : market.outcomePrices;
          if (Array.isArray(prices) && prices.length > 0) {
            market.price = parseFloat(prices[0]) || 0.5;
            // Estimate bid/ask from embedded price (tight spread assumption)
            market.bestBid = Math.max(0, market.price - 0.02);
            market.bestAsk = Math.min(1, market.price + 0.02);
          }
        } catch (e) {}
      }

      // Map Gamma fields to scanner-expected fields
      market.endDate = market.endDateIso || market.endDate;
      market.volume24h = parseFloat(market.volume24hr || market.volume || '0');
      market.liquidity = parseFloat(market.liquidityNum || market.liquidity || '0');
      market.settled = market.settled === true || market.settled === 'true';

      // Secondary: Try CLOB order book for more accurate prices (only if active)
      if (market.active && !market.closed) {
        const { yesTokenId } = extractTokenIds(market);
        if (yesTokenId) {
          try {
            const priceData = await getOutcomePrices(yesTokenId);
            if (priceData.bestAsk !== 0.5 || priceData.bestBid !== 0.5) {
              // Only override if we got real data (not defaults)
              market.price = priceData.bestAsk;
              market.bestBid = priceData.bestBid;
              market.bestAsk = priceData.bestAsk;
              market.liquidity = priceData.liquidity;
            }
          } catch (e) {
            // CLOB failed, keep Gamma prices
          }
        }
      }
    }

    // Use the settlement lag scanner
    const scanner = new SettlementLagScanner();
    const opportunities = scanner.scan(recentMarkets);

    const result = {
      opportunities,
      stats: {
        totalMarkets: recentMarkets.length,
        marketsAnalyzed: recentMarkets.filter(m => m.price !== undefined).length,
        opportunitiesFound: opportunities.length,
        totalPotentialProfit: opportunities.reduce((sum, o) => sum + o.potentialProfit, 0),
      },
      scanTime: Date.now() - startTime,
      timestamp: Date.now(),
    };

    lastSettlementLagScan = result;

    console.log('[ARB-TYPE3] ────────────────────────────────────────────────────');
    console.log(`[ARB-TYPE3] Scan complete in ${result.scanTime}ms`);
    console.log(`[ARB-TYPE3] Markets analyzed: ${result.stats.marketsAnalyzed}`);
    console.log(`[ARB-TYPE3] Opportunities found: ${result.stats.opportunitiesFound}`);
    console.log('[ARB-TYPE3] ════════════════════════════════════════════════════\n');

    res.json(result);
  } catch (error) {
    console.error('[ARB-TYPE3] Scan error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get cached settlement lag result
app.get('/api/arbitrage/settlement-lag/result', (req, res) => {
  if (lastSettlementLagScan) {
    res.json(lastSettlementLagScan);
  } else {
    res.json({
      opportunities: [],
      stats: {
        totalMarkets: 0,
        marketsAnalyzed: 0,
        opportunitiesFound: 0,
        totalPotentialProfit: 0,
      },
      errors: ['No settlement lag scan performed yet. Call /api/arbitrage/settlement-lag first.'],
      timestamp: Date.now(),
    });
  }
});

/**
 * Analyze markets for cross-market dependencies
 */
async function analyzeCrossMarketDependencies(markets) {
  const DATE_PATTERNS = [
    /by\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{1,2})?,?\s*(\d{4})?/i,
    /before\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{1,2})?,?\s*(\d{4})?/i,
    /in\s+(Q[1-4])\s*(\d{4})?/i,
    /by\s+(Q[1-4])\s*(\d{4})?/i,
    /by\s+end\s+of\s+(\d{4})/i,
    /by\s+(20\d{2})/i,
  ];

  const THRESHOLD_PATTERNS = [
    /(?:above|over|exceed|reach|hit)\s*\$?([\d,]+(?:\.\d+)?)/i,
    /(?:below|under)\s*\$?([\d,]+(?:\.\d+)?)/i,
    />\s*\$?([\d,]+(?:\.\d+)?)/i,
    /<\s*\$?([\d,]+(?:\.\d+)?)/i,
  ];

  const MONTH_ORDER = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };

  // Helper functions
  function extractSubject(question) {
    if (!question) return '';
    let subject = question
      .replace(/^(will|can|does|is|are|has|have|do)\s+/i, '')
      .replace(/\?$/, '')
      .toLowerCase()
      .trim();
    for (const pattern of DATE_PATTERNS) {
      subject = subject.replace(pattern, '');
    }
    for (const pattern of THRESHOLD_PATTERNS) {
      subject = subject.replace(pattern, '');
    }
    return subject.trim();
  }

  function extractDeadline(question) {
    if (!question) return null;
    for (const pattern of DATE_PATTERNS) {
      const match = question.match(pattern);
      if (match) {
        const raw = match[0];
        if (match[1] && match[1].startsWith('Q')) {
          const quarter = parseInt(match[1][1]);
          const year = parseInt(match[2]) || new Date().getFullYear();
          const endMonth = quarter * 3;
          return { month: endMonth, day: 31, year, quarter, raw };
        }
        const month = MONTH_ORDER[match[1]?.toLowerCase()];
        if (month) {
          const day = parseInt(match[2]) || 31;
          const year = parseInt(match[3]) || new Date().getFullYear();
          return { month, day, year, quarter: null, raw };
        }
        const yearMatch = match[1]?.match(/^20\d{2}$/);
        if (yearMatch) {
          return { month: 12, day: 31, year: parseInt(match[1]), quarter: null, raw };
        }
      }
    }
    return null;
  }

  function extractThreshold(question) {
    if (!question) return null;
    const aboveMatch = question.match(/(?:above|over|exceed|reach|hit|>|at\s+least)\s*\$?([\d,]+(?:\.\d+)?)/i);
    if (aboveMatch) {
      return { value: parseFloat(aboveMatch[1].replace(/,/g, '')), direction: 'above' };
    }
    const belowMatch = question.match(/(?:below|under|<)\s*\$?([\d,]+(?:\.\d+)?)/i);
    if (belowMatch) {
      return { value: parseFloat(belowMatch[1].replace(/,/g, '')), direction: 'below' };
    }
    return null;
  }

  function compareDeadlines(a, b) {
    if (!a || !b) return 0;
    const dateA = new Date(a.year, a.month - 1, a.day);
    const dateB = new Date(b.year, b.month - 1, b.day);
    if (dateA < dateB) return -1;
    if (dateA > dateB) return 1;
    return 0;
  }

  function subjectSimilarity(subjectA, subjectB) {
    if (!subjectA || !subjectB) return 0;
    const wordsA = new Set(subjectA.toLowerCase().split(/\s+/));
    const wordsB = new Set(subjectB.toLowerCase().split(/\s+/));
    const stopWords = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by']);
    const filteredA = [...wordsA].filter(w => !stopWords.has(w) && w.length > 2);
    const filteredB = [...wordsB].filter(w => !stopWords.has(w) && w.length > 2);
    if (filteredA.length === 0 || filteredB.length === 0) return 0;
    const intersection = filteredA.filter(w => filteredB.includes(w)).length;
    const union = new Set([...filteredA, ...filteredB]).size;
    return intersection / union;
  }

  // Extract market prices
  const marketsWithPrices = markets.map(m => ({
    id: m.conditionId || m.id,
    question: m.question,
    slug: m.slug,
    price: parseFloat(m.outcomePrices?.[0] || m.bestAsk || '0.5'),
    category: m.category || m.groupItemTitle,
  }));

  // Find temporal dependencies
  const temporalDeps = [];
  const marketsWithDeadlines = marketsWithPrices
    .map(m => ({ ...m, deadline: extractDeadline(m.question), subject: extractSubject(m.question) }))
    .filter(m => m.deadline && m.subject);

  for (let i = 0; i < marketsWithDeadlines.length; i++) {
    for (let j = i + 1; j < marketsWithDeadlines.length; j++) {
      const a = marketsWithDeadlines[i];
      const b = marketsWithDeadlines[j];

      const similarity = subjectSimilarity(a.subject, b.subject);
      if (similarity < 0.5) continue;

      const cmp = compareDeadlines(a.deadline, b.deadline);
      if (cmp === 0) continue;

      const earlier = cmp < 0 ? a : b;
      const later = cmp < 0 ? b : a;

      // Earlier deadline should have lower or equal probability
      const violation = earlier.price > later.price + 0.01; // 1% tolerance
      const profit = violation ? earlier.price - later.price : 0;
      const fees = arbitrageConfig.feeRate * 4;
      const profitAfterFees = profit - fees;

      temporalDeps.push({
        type: 'temporal',
        marketA: { id: earlier.id, question: earlier.question, price: earlier.price },
        marketB: { id: later.id, question: later.question, price: later.price },
        expectedRelation: 'A <= B',
        reasoning: `"${earlier.deadline.raw}" must occur before "${later.deadline.raw}"`,
        violation,
        arbitrageProfit: profit,
        profitAfterFees,
        qualifies: profitAfterFees > 0,
        reasons: violation
          ? [`P(earlier) ${earlier.price.toFixed(3)} > P(later) ${later.price.toFixed(3)}`]
          : ['No violation'],
      });
    }
  }

  // Find threshold dependencies
  const thresholdDeps = [];
  const marketsWithThresholds = marketsWithPrices
    .map(m => ({ ...m, threshold: extractThreshold(m.question), subject: extractSubject(m.question) }))
    .filter(m => m.threshold && m.subject);

  for (let i = 0; i < marketsWithThresholds.length; i++) {
    for (let j = i + 1; j < marketsWithThresholds.length; j++) {
      const a = marketsWithThresholds[i];
      const b = marketsWithThresholds[j];

      const similarity = subjectSimilarity(a.subject, b.subject);
      if (similarity < 0.5) continue;

      if (a.threshold.direction !== b.threshold.direction) continue;
      if (Math.abs(a.threshold.value - b.threshold.value) < 0.01) continue;

      let higher, lower;
      if (a.threshold.direction === 'above') {
        higher = a.threshold.value > b.threshold.value ? a : b;
        lower = a.threshold.value > b.threshold.value ? b : a;
      } else {
        higher = a.threshold.value < b.threshold.value ? a : b;
        lower = a.threshold.value < b.threshold.value ? b : a;
      }

      // Higher threshold should have lower or equal probability (for "above")
      const violation = higher.price > lower.price + 0.01;
      const profit = violation ? higher.price - lower.price : 0;
      const fees = arbitrageConfig.feeRate * 4;
      const profitAfterFees = profit - fees;

      thresholdDeps.push({
        type: 'threshold',
        marketA: { id: higher.id, question: higher.question, price: higher.price },
        marketB: { id: lower.id, question: lower.question, price: lower.price },
        expectedRelation: 'A <= B',
        reasoning: `Reaching ${higher.threshold.value} requires reaching ${lower.threshold.value} first`,
        violation,
        arbitrageProfit: profit,
        profitAfterFees,
        qualifies: profitAfterFees > 0,
        reasons: violation
          ? [`P(harder) ${higher.price.toFixed(3)} > P(easier) ${lower.price.toFixed(3)}`]
          : ['No violation'],
      });
    }
  }

  const allDeps = [...temporalDeps, ...thresholdDeps];
  const opportunities = allDeps.filter(d => d.qualifies);

  return {
    dependencies: allDeps,
    opportunities,
    stats: {
      totalMarkets: markets.length,
      temporalDependencies: temporalDeps.length,
      thresholdDependencies: thresholdDeps.length,
      violations: allDeps.filter(d => d.violation).length,
      qualifyingOpportunities: opportunities.length,
    },
    timestamp: Date.now(),
  };
}

// ============================================================================
// START SERVER
// ============================================================================

// Initialize databases before starting server
Promise.all([
  auditStorage.initDatabase(),
  configPresets.initPresetsDatabase(),
]).then(() => {
  console.log('[DB] All databases initialized');

  // Auto-run initial arbitrage scan after startup
  setTimeout(() => {
    console.log('[ARB-FW] Running initial multi-outcome arbitrage scan...');
    runMultiOutcomeArbitrageScan();
  }, 5000); // Wait 5s for everything to initialize
}).catch(err => {
  console.error('[DB] Failed to initialize databases:', err);
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Polymarket Backend Server                                   ║
║  Using official @polymarket/clob-client + WebSocket          ║
║                                                              ║
║  REST API:     http://localhost:${PORT}                         ║
║  WebSocket:    ws://localhost:${WS_PORT}                          ║
║                                                              ║
║  REST Endpoints:                                             ║
║    GET /api/markets/crypto-15m     - 15-min crypto markets   ║
║    GET /api/markets/crypto-hourly  - Hourly crypto markets   ║
║    GET /api/book/:tokenId          - Order book              ║
║    GET /api/price/:yes/:no         - Price tick              ║
║    GET /api/health                 - Health check            ║
║                                                              ║
║  Arbitrage Scanner:                                          ║
║    GET /api/arbitrage/scan         - Scan all markets        ║
║    GET /api/arbitrage/result       - Last scan results       ║
║    GET /api/arbitrage/config       - Get scanner config      ║
║   POST /api/arbitrage/config       - Update scanner config   ║
║                                                              ║
║  WebSocket Messages:                                         ║
║    → { action: 'subscribe', tokenIds: [...] }                ║
║    ← { type: 'price', tokenId, bestAsk, bestBid, ... }       ║
╚══════════════════════════════════════════════════════════════╝
`);
});
