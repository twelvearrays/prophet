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

    // Liquidity = sum of top 5 bid levels
    const yesLiquidity = (yesBook.bids || []).slice(0, 5).reduce(
      (sum, b) => sum + parseFloat(b.size) * parseFloat(b.price),
      0
    );
    const noLiquidity = (noBook.bids || []).slice(0, 5).reduce(
      (sum, b) => sum + parseFloat(b.size) * parseFloat(b.price),
      0
    );

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
// START SERVER
// ============================================================================

// Initialize databases before starting server
Promise.all([
  auditStorage.initDatabase(),
  configPresets.initPresetsDatabase(),
]).then(() => {
  console.log('[DB] All databases initialized');
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
║  WebSocket Messages:                                         ║
║    → { action: 'subscribe', tokenIds: [...] }                ║
║    ← { type: 'price', tokenId, bestAsk, bestBid, ... }       ║
╚══════════════════════════════════════════════════════════════╝
`);
});
