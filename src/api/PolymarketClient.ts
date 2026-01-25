import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { PriceTick, Side } from '../types';

// ============================================================================
// POLYMARKET API CLIENT
// ============================================================================
// Based on working Python SDK patterns for 15-minute crypto markets.
//
// Key insight: Markets use slug-based lookup:
//   15-min: {asset}-updown-15m-{timestamp}  (timestamp = 900-second boundary)
//   Hourly: {asset}-up-or-down-{month}-{day}-{hour}{am/pm}-et
// ============================================================================

export interface PolymarketConfig {
  clobBaseUrl: string;
  gammaBaseUrl: string;
  wsUrl: string;
}

export const DEFAULT_POLYMARKET_CONFIG: PolymarketConfig = {
  clobBaseUrl: 'https://clob.polymarket.com',
  gammaBaseUrl: 'https://gamma-api.polymarket.com',
  wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
};

/**
 * Market from Polymarket API
 */
export interface Market {
  conditionId: string;
  questionId?: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  endDate: string;
  clobTokenIds?: string[] | string;  // Can be JSON string or array!
  tokens?: Array<{
    token_id: string;
    outcome: string;
  }>;
  // Internal fields added by our SDK
  _asset?: string;
  _end_time?: Date;
  _slug?: string;
}

/**
 * Crypto market (parsed)
 */
export interface CryptoMarket {
  conditionId: string;
  questionId: string;
  yesTokenId: string;
  noTokenId: string;
  question: string;
  endTime: Date;
  asset: string;       // BTC, ETH, SOL, XRP
  slug: string;
}

/**
 * Order book entry
 */
export interface OrderBookEntry {
  price: string;
  size: string;
}

/**
 * Order book
 */
export interface OrderBook {
  asset_id: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
}

export class PolymarketClient {
  private config: PolymarketConfig;
  private http: AxiosInstance;
  private ws: WebSocket | null = null;
  private markets: Map<string, { yesToken: string; noToken: string; yesAsk?: number; yesBid?: number; noAsk?: number; noBid?: number }> = new Map();
  private priceCallbacks: Map<string, (tick: PriceTick) => void> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor(config: Partial<PolymarketConfig> = {}) {
    this.config = { ...DEFAULT_POLYMARKET_CONFIG, ...config };
    this.http = axios.create({
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
  }

  // ==========================================================================
  // MARKET DISCOVERY - Using slug-based lookup (matches Python SDK)
  // ==========================================================================

  /**
   * Get active 15-minute crypto markets using slug pattern.
   * Slug format: {asset}-updown-15m-{timestamp}
   */
  async getCryptoMarkets(assets: string[] = ['BTC', 'ETH', 'SOL', 'XRP']): Promise<CryptoMarket[]> {
    const cryptoMarkets: CryptoMarket[] = [];

    // Calculate current 15-minute window timestamp (900-second boundary)
    const nowTs = Math.floor(Date.now() / 1000);
    const baseTs = Math.floor(nowTs / 900) * 900;

    for (const asset of assets) {
      // Build slug: {asset}-updown-15m-{timestamp}
      const slug = `${asset.toLowerCase()}-updown-15m-${baseTs}`;

      try {
        const response = await this.http.get(`${this.config.gammaBaseUrl}/markets`, {
          params: { slug },
        });

        const markets = Array.isArray(response.data) ? response.data : [response.data].filter(Boolean);

        for (const m of markets) {
          if (m && m.active && !m.closed) {
            // Extract token IDs
            let yesTokenId = '';
            let noTokenId = '';

            // Try clobTokenIds first (newer format)
            // NOTE: clobTokenIds may be a JSON string, not an array!
            if (m.clobTokenIds) {
              const tokenIds = typeof m.clobTokenIds === 'string'
                ? JSON.parse(m.clobTokenIds)
                : m.clobTokenIds;
              if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
                yesTokenId = tokenIds[0];
                noTokenId = tokenIds[1];
              }
            }
            // Fall back to tokens array
            if ((!yesTokenId || !noTokenId) && m.tokens && m.tokens.length >= 2) {
              const yesToken = m.tokens.find((t: any) => t.outcome?.toLowerCase() === 'yes');
              const noToken = m.tokens.find((t: any) => t.outcome?.toLowerCase() === 'no');
              yesTokenId = yesToken?.token_id || '';
              noTokenId = noToken?.token_id || '';
            }

            if (!yesTokenId || !noTokenId) {
              console.warn(`[API] Missing token IDs for ${asset} market`);
              continue;
            }

            // Parse end time
            let endTime: Date;
            const endDate = m.endDate || m.end_date;
            if (endDate) {
              if (typeof endDate === 'string') {
                endTime = new Date(endDate.endsWith('Z') ? endDate : endDate + 'Z');
              } else {
                endTime = new Date(endDate * 1000);
              }
            } else {
              // Fallback: current window + 15 minutes
              endTime = new Date((baseTs + 900) * 1000);
            }

            cryptoMarkets.push({
              conditionId: m.conditionId || m.condition_id,
              questionId: m.questionId || m.question_id || '',
              yesTokenId,
              noTokenId,
              question: m.question || '',
              endTime,
              asset: asset.toUpperCase(),
              slug,
            });

            console.log(`[API] Found ${asset} market: ${m.question?.slice(0, 50)}`);
          }
        }
      } catch (error: any) {
        // 404 means no market for this asset/timestamp - that's OK
        if (error.response?.status !== 404) {
          console.error(`[API] Failed to fetch ${asset} market:`, error.message);
        }
      }
    }

    console.log(`[API] Found ${cryptoMarkets.length} active 15-min crypto markets`);
    return cryptoMarkets;
  }

  /**
   * Get active hourly crypto markets.
   * Slug format: {asset}-up-or-down-{month}-{day}-{hour}{am/pm}-et
   */
  async getHourlyCryptoMarkets(assets: string[] = ['BTC', 'ETH']): Promise<CryptoMarket[]> {
    const cryptoMarkets: CryptoMarket[] = [];

    // Asset to slug prefix mapping
    const assetSlugMap: Record<string, string> = {
      'BTC': 'bitcoin',
      'ETH': 'ethereum',
    };

    // Get current time in ET
    const now = new Date();
    const etFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      hour12: true,
    });

    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december'];

    for (const asset of assets) {
      const assetSlug = assetSlugMap[asset.toUpperCase()];
      if (!assetSlug) continue;

      // Try current hour and next few hours
      for (let hourOffset = 0; hourOffset < 4; hourOffset++) {
        const targetTime = new Date(now.getTime() + hourOffset * 60 * 60 * 1000);

        // Get ET time components
        const etParts = etFormatter.formatToParts(targetTime);
        const month = etParts.find(p => p.type === 'month')?.value?.toLowerCase() || '';
        const day = etParts.find(p => p.type === 'day')?.value || '';
        const hour = etParts.find(p => p.type === 'hour')?.value || '';
        const dayPeriod = etParts.find(p => p.type === 'dayPeriod')?.value?.toLowerCase() || '';

        // Build slug: bitcoin-up-or-down-january-22-11pm-et
        const slug = `${assetSlug}-up-or-down-${month}-${day}-${hour}${dayPeriod}-et`;

        try {
          const response = await this.http.get(`${this.config.gammaBaseUrl}/events`, {
            params: { slug, active: 'true', closed: 'false' },
          });

          const events = Array.isArray(response.data) ? response.data : [];

          for (const event of events) {
            const markets = event.markets || [];
            for (const m of markets) {
              if (m && m.active && !m.closed) {
                // Check if we already have this market
                if (cryptoMarkets.some(cm => cm.conditionId === (m.conditionId || m.id))) {
                  continue;
                }

                // Extract token IDs
                let yesTokenId = '';
                let noTokenId = '';

                // NOTE: clobTokenIds may be a JSON string, not an array!
                if (m.clobTokenIds) {
                  const tokenIds = typeof m.clobTokenIds === 'string'
                    ? JSON.parse(m.clobTokenIds)
                    : m.clobTokenIds;
                  if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
                    yesTokenId = tokenIds[0];
                    noTokenId = tokenIds[1];
                  }
                }
                if ((!yesTokenId || !noTokenId) && m.tokens && m.tokens.length >= 2) {
                  const yesToken = m.tokens.find((t: any) => t.outcome?.toLowerCase() === 'yes');
                  const noToken = m.tokens.find((t: any) => t.outcome?.toLowerCase() === 'no');
                  yesTokenId = yesToken?.token_id || '';
                  noTokenId = noToken?.token_id || '';
                }

                if (!yesTokenId || !noTokenId) continue;

                // Parse end time
                const endDate = m.endDate || m.end_date;
                let endTime = new Date();
                if (endDate) {
                  endTime = new Date(typeof endDate === 'string' ? endDate : endDate * 1000);
                }

                cryptoMarkets.push({
                  conditionId: m.conditionId || m.id,
                  questionId: m.questionId || '',
                  yesTokenId,
                  noTokenId,
                  question: m.question || '',
                  endTime,
                  asset: asset.toUpperCase(),
                  slug,
                });

                console.log(`[API] Found ${asset} hourly market: ${m.question?.slice(0, 50)}`);
              }
            }
          }
        } catch (error: any) {
          if (error.response?.status !== 404) {
            console.error(`[API] Failed to fetch ${asset} hourly market:`, error.message);
          }
        }
      }
    }

    console.log(`[API] Found ${cryptoMarkets.length} active hourly crypto markets`);
    return cryptoMarkets;
  }

  // ==========================================================================
  // PRICING
  // ==========================================================================

  /**
   * Get order book for a token
   */
  async getOrderBook(tokenId: string): Promise<OrderBook> {
    const response = await this.http.get(`${this.config.clobBaseUrl}/book`, {
      params: { token_id: tokenId },
    });
    return response.data;
  }

  /**
   * Get YES/NO prices from order books
   */
  async getPrices(yesTokenId: string, noTokenId: string): Promise<{ yesPrice: number; noPrice: number }> {
    try {
      const yesBook = await this.getOrderBook(yesTokenId);

      // Best ask is what you pay to buy YES
      const yesAsk = yesBook.asks?.length > 0 ? parseFloat(yesBook.asks[0].price) : 0.5;

      // NO price is complement (or get from NO book)
      const noPrice = 1 - yesAsk;

      return { yesPrice: yesAsk, noPrice };
    } catch (error) {
      console.error('[API] Failed to get prices:', error);
      return { yesPrice: 0.5, noPrice: 0.5 };
    }
  }

  /**
   * Get full price tick with liquidity
   */
  async getPriceTick(yesTokenId: string, noTokenId: string): Promise<PriceTick> {
    try {
      const [yesBook, noBook] = await Promise.all([
        this.getOrderBook(yesTokenId),
        this.getOrderBook(noTokenId),
      ]);

      // Best ask = lowest ask = what you pay to buy
      const yesAsk = yesBook.asks?.length > 0
        ? Math.min(...yesBook.asks.map(a => parseFloat(a.price)))
        : 0.5;
      const noAsk = noBook.asks?.length > 0
        ? Math.min(...noBook.asks.map(a => parseFloat(a.price)))
        : 0.5;

      // Best bid = highest bid = what you receive when selling
      const yesBid = yesBook.bids?.length > 0
        ? Math.max(...yesBook.bids.map(b => parseFloat(b.price)))
        : 0;
      const noBid = noBook.bids?.length > 0
        ? Math.max(...noBook.bids.map(b => parseFloat(b.price)))
        : 0;

      // Liquidity = sum of top 5 bid levels (USD available)
      const yesLiquidity = (yesBook.bids || []).slice(0, 5).reduce(
        (sum, b) => sum + parseFloat(b.size) * parseFloat(b.price),
        0
      );
      const noLiquidity = (noBook.bids || []).slice(0, 5).reduce(
        (sum, b) => sum + parseFloat(b.size) * parseFloat(b.price),
        0
      );

      return {
        timestamp: Date.now(),
        yesPrice: yesAsk,
        noPrice: noAsk,
        yesLiquidity,
        noLiquidity,
      };
    } catch (error) {
      console.error('[API] Failed to get price tick:', error);
      return {
        timestamp: Date.now(),
        yesPrice: 0.5,
        noPrice: 0.5,
        yesLiquidity: 0,
        noLiquidity: 0,
      };
    }
  }

  // ==========================================================================
  // WEBSOCKET STREAMING (matches Python PriceStream)
  // ==========================================================================

  /**
   * Connect to WebSocket for real-time price updates
   */
  async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws) {
        this.ws.close();
      }

      this.ws = new WebSocket(this.config.wsUrl);

      this.ws.on('open', () => {
        console.log('[WS] Connected to Polymarket');
        this.reconnectAttempts = 0;
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          // Skip non-JSON messages (subscription acks)
        }
      });

      this.ws.on('close', () => {
        console.log('[WS] Connection closed');
        this.attemptReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('[WS] Error:', error);
        reject(error);
      });
    });
  }

  private handleMessage(data: any): void {
    // Handle list of orderbooks
    if (Array.isArray(data)) {
      for (const item of data) {
        this.processOrderbook(item);
      }
      return;
    }

    if (typeof data !== 'object') return;

    // Handle price_change events (have best_bid/best_ask directly)
    if (data.event_type === 'price_change') {
      const changes = data.price_changes || [];
      for (const change of changes) {
        this.processPriceChange(change);
      }
      return;
    }

    // Handle orderbook updates
    if (data.bids || data.asks) {
      this.processOrderbook(data);
    }
  }

  private processPriceChange(change: any): void {
    const tokenId = change.asset_id;
    if (!tokenId) return;

    const bestAsk = change.best_ask ? parseFloat(change.best_ask) : null;
    const bestBid = change.best_bid ? parseFloat(change.best_bid) : null;

    if (bestAsk === null) return;

    // Find market this token belongs to
    for (const [marketId, marketData] of this.markets.entries()) {
      if (tokenId === marketData.yesToken) {
        marketData.yesAsk = bestAsk;
        if (bestBid !== null) marketData.yesBid = bestBid;
        this.checkAndFireCallback(marketId, marketData);
      } else if (tokenId === marketData.noToken) {
        marketData.noAsk = bestAsk;
        if (bestBid !== null) marketData.noBid = bestBid;
        this.checkAndFireCallback(marketId, marketData);
      }
    }
  }

  private processOrderbook(data: any): void {
    const tokenId = data.asset_id;
    if (!tokenId) return;

    // Best ask = lowest ask
    const asks = data.asks || [];
    const bestAsk = asks.length > 0
      ? Math.min(...asks.map((a: any) => parseFloat(a.price)))
      : null;

    // Best bid = highest bid
    const bids = data.bids || [];
    const bestBid = bids.length > 0
      ? Math.max(...bids.map((b: any) => parseFloat(b.price)))
      : null;

    if (bestAsk === null) return;

    // Find market this token belongs to
    for (const [marketId, marketData] of this.markets.entries()) {
      if (tokenId === marketData.yesToken) {
        marketData.yesAsk = bestAsk;
        if (bestBid !== null) marketData.yesBid = bestBid;
        this.checkAndFireCallback(marketId, marketData);
      } else if (tokenId === marketData.noToken) {
        marketData.noAsk = bestAsk;
        if (bestBid !== null) marketData.noBid = bestBid;
        this.checkAndFireCallback(marketId, marketData);
      }
    }
  }

  private checkAndFireCallback(marketId: string, marketData: any): void {
    // Only fire if we have both YES and NO prices
    if (marketData.yesAsk === undefined || marketData.noAsk === undefined) {
      return;
    }

    const callback = this.priceCallbacks.get(marketId);
    if (callback) {
      const tick: PriceTick = {
        timestamp: Date.now(),
        yesPrice: marketData.yesAsk,
        noPrice: marketData.noAsk,
        yesLiquidity: 100, // Would need depth tracking for accurate liquidity
        noLiquidity: 100,
      };
      callback(tick);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(async () => {
      try {
        await this.connectWebSocket();
        // Re-subscribe to all markets
        if (this.markets.size > 0) {
          const tokenIds: string[] = [];
          for (const marketData of this.markets.values()) {
            tokenIds.push(marketData.yesToken, marketData.noToken);
          }
          this.sendSubscribe(tokenIds);
        }
      } catch (error) {
        console.error('[WS] Reconnect failed:', error);
      }
    }, delay);
  }

  private sendSubscribe(tokenIds: string[]): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg = {
        assets_ids: tokenIds,
        type: 'market',
      };
      this.ws.send(JSON.stringify(msg));
      console.log(`[WS] Subscribed to ${tokenIds.length} tokens`);
    }
  }

  /**
   * Subscribe to price updates for a market
   */
  subscribeToMarket(
    market: CryptoMarket,
    callback: (tick: PriceTick) => void
  ): () => void {
    // Register market
    this.markets.set(market.conditionId, {
      yesToken: market.yesTokenId,
      noToken: market.noTokenId,
    });
    this.priceCallbacks.set(market.conditionId, callback);

    // Send subscription (includes all tokens)
    const tokenIds: string[] = [];
    for (const marketData of this.markets.values()) {
      tokenIds.push(marketData.yesToken, marketData.noToken);
    }
    this.sendSubscribe(tokenIds);

    // Return unsubscribe function
    return () => {
      this.markets.delete(market.conditionId);
      this.priceCallbacks.delete(market.conditionId);
    };
  }

  /**
   * Disconnect WebSocket
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.markets.clear();
    this.priceCallbacks.clear();
  }

  // ==========================================================================
  // POLLING (alternative to WebSocket)
  // ==========================================================================

  /**
   * Poll prices at regular intervals
   */
  startPolling(
    yesTokenId: string,
    noTokenId: string,
    callback: (tick: PriceTick) => void,
    intervalMs: number = 1000
  ): () => void {
    let running = true;

    const poll = async () => {
      while (running) {
        try {
          const tick = await this.getPriceTick(yesTokenId, noTokenId);
          callback(tick);
        } catch (error) {
          console.error('[POLL] Error fetching price:', error);
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    };

    poll();

    return () => {
      running = false;
    };
  }
}
