/**
 * Frank-Wolfe Arbitrage Engine
 *
 * Based on "Arbitrage-Free Combinatorial Market Making via Integer Programming"
 * (Kroer et al. 2016) and Polymarket arbitrage analysis.
 *
 * Key concepts:
 * - NegRisk markets: Multi-outcome markets where probabilities MUST sum to 1
 * - Mispricing: When sum of outcome prices ≠ 1
 * - Profit guarantee: D(μ̂||θ) - g(μ̂) where D is Bregman divergence, g is FW gap
 *
 * Types of arbitrage (from the research):
 * - Type 1: Within-market (sum ≠ 1) - what we detect here
 * - Type 2: Cross-market dependencies - requires relationship mapping
 * - Type 3: Settlement lag - requires event monitoring
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

// Configuration
const config = {
  minMispricing: 0.02,      // 2% minimum mispricing to consider (after fees)
  feeRate: 0.02,            // 2% fee per trade
  minLiquidity: 100,        // Minimum $100 liquidity per outcome
  alphaExtraction: 0.9,     // Stop when we can extract 90% of profit (from article)
  maxOutcomes: 20,          // Max outcomes per event to analyze
};

/**
 * Represents a multi-outcome event (e.g., "Who will win the primary?")
 */
class MultiOutcomeEvent {
  constructor(eventData) {
    this.id = eventData.id;
    this.slug = eventData.slug;
    this.title = eventData.title;
    this.description = eventData.description;
    this.markets = []; // Individual outcome markets
    this.isNegRisk = eventData.negRisk || false;
    this.lastUpdated = Date.now();
  }

  /**
   * Add a market (outcome) to this event
   */
  addMarket(marketData) {
    this.markets.push({
      id: marketData.conditionId || marketData.id,
      question: marketData.question,
      outcome: marketData.groupItemTitle || marketData.question,
      yesTokenId: null,
      noTokenId: null,
      yesPrice: 0.5,
      yesBid: 0.5,
      yesLiquidity: 0,
      volume24h: parseFloat(marketData.volume24hr || '0'),
      active: marketData.active,
      closed: marketData.closed,
    });
  }

  /**
   * Calculate total probability (should be 1.0 for valid market)
   */
  getTotalProbability() {
    return this.markets.reduce((sum, m) => sum + m.yesPrice, 0);
  }

  /**
   * Calculate mispricing (deviation from 1.0)
   * Positive = overbought (sum > 1), Negative = underbought (sum < 1)
   */
  getMispricing() {
    return this.getTotalProbability() - 1.0;
  }

  /**
   * Get absolute mispricing
   */
  getAbsoluteMispricing() {
    return Math.abs(this.getMispricing());
  }

  /**
   * Determine arbitrage opportunity type
   * - BUY_ALL: Sum < 1, buy all outcomes for guaranteed profit
   * - SELL_ALL: Sum > 1, sell all outcomes for guaranteed profit
   */
  getOpportunityType() {
    const mispricing = this.getMispricing();
    if (mispricing < -config.minMispricing) return 'BUY_ALL';
    if (mispricing > config.minMispricing) return 'SELL_ALL';
    return 'NONE';
  }

  /**
   * Calculate raw profit before fees
   * For BUY_ALL: profit = 1 - sum(prices)
   * For SELL_ALL: profit = sum(prices) - 1
   */
  getRawProfit() {
    const mispricing = this.getMispricing();
    if (mispricing < 0) return Math.abs(mispricing); // BUY_ALL
    if (mispricing > 0) return mispricing; // SELL_ALL
    return 0;
  }

  /**
   * Calculate profit after fees
   * Fee is charged on each leg of the trade
   */
  getProfitAfterFees() {
    const rawProfit = this.getRawProfit();
    const numOutcomes = this.markets.length;
    const totalFees = numOutcomes * config.feeRate * 2; // Fee on buy and sell
    return rawProfit - totalFees;
  }

  /**
   * Check if this qualifies as an arbitrage opportunity
   */
  qualifiesForArbitrage() {
    // Must have profitable opportunity after fees
    if (this.getProfitAfterFees() <= 0) return false;

    // Must have minimum liquidity across all outcomes
    const minLiq = Math.min(...this.markets.map(m => m.yesLiquidity));
    if (minLiq < config.minLiquidity) return false;

    // Must have reasonable number of outcomes
    if (this.markets.length < 2 || this.markets.length > config.maxOutcomes) return false;

    return true;
  }

  /**
   * Get detailed analysis of the opportunity
   */
  getAnalysis() {
    const total = this.getTotalProbability();
    const mispricing = this.getMispricing();
    const oppType = this.getOpportunityType();
    const rawProfit = this.getRawProfit();
    const profitAfterFees = this.getProfitAfterFees();
    const qualifies = this.qualifiesForArbitrage();

    const reasons = [];

    if (Math.abs(mispricing) < config.minMispricing) {
      reasons.push(`Mispricing too small: ${(Math.abs(mispricing) * 100).toFixed(2)}% < ${(config.minMispricing * 100).toFixed(0)}% threshold`);
    }

    if (profitAfterFees <= 0 && rawProfit > 0) {
      const fees = rawProfit - profitAfterFees;
      reasons.push(`Fees exceed profit: ${(rawProfit * 100).toFixed(2)}% profit - ${(fees * 100).toFixed(2)}% fees`);
    }

    const minLiq = Math.min(...this.markets.map(m => m.yesLiquidity));
    if (minLiq < config.minLiquidity) {
      reasons.push(`Insufficient liquidity: $${minLiq.toFixed(0)} < $${config.minLiquidity} minimum`);
    }

    if (qualifies) {
      reasons.push(`✓ ARBITRAGE OPPORTUNITY: ${oppType}`);
      reasons.push(`✓ ${oppType === 'BUY_ALL' ? 'Buy' : 'Sell'} all ${this.markets.length} outcomes`);
      reasons.push(`✓ Guaranteed profit: ${(profitAfterFees * 100).toFixed(2)}%`);
    }

    return {
      eventId: this.id,
      title: this.title,
      slug: this.slug,
      numOutcomes: this.markets.length,
      totalProbability: total,
      mispricing,
      absoluteMispricing: Math.abs(mispricing),
      opportunityType: oppType,
      rawProfit,
      profitAfterFees,
      qualifies,
      reasons,
      outcomes: this.markets.map(m => ({
        outcome: m.outcome,
        price: m.yesPrice,
        liquidity: m.yesLiquidity,
      })),
      lastUpdated: this.lastUpdated,
    };
  }
}

/**
 * Fetch all active events from Polymarket
 */
async function fetchActiveEvents(maxEvents = 100) {
  const events = [];
  let offset = 0;
  const limit = 50;

  while (events.length < maxEvents) {
    try {
      const url = `${GAMMA_API}/events?active=true&closed=false&limit=${limit}&offset=${offset}`;
      console.log(`[ARB-ENGINE] Fetching events: offset=${offset}`);

      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; ArbitrageBot/1.0)',
        },
      });

      if (!response.ok) break;
      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) break;

      events.push(...data);
      offset += limit;

      // Rate limiting
      await new Promise(r => setTimeout(r, 100));
    } catch (error) {
      console.error('[ARB-ENGINE] Failed to fetch events:', error.message);
      break;
    }
  }

  console.log(`[ARB-ENGINE] Fetched ${events.length} events`);
  return events;
}

/**
 * Fetch markets for a specific event
 */
async function fetchEventMarkets(eventSlug) {
  try {
    const url = `${GAMMA_API}/events/${eventSlug}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; ArbitrageBot/1.0)',
      },
    });

    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error(`[ARB-ENGINE] Failed to fetch event ${eventSlug}:`, error.message);
    return null;
  }
}

/**
 * Get order book prices for a token
 */
async function getBookPrices(tokenId, clobClient) {
  try {
    const book = await clobClient.getOrderBook(tokenId);
    const asks = book?.asks || [];
    const bids = book?.bids || [];

    const bestAsk = asks.length > 0
      ? Math.min(...asks.map(a => parseFloat(a.price)))
      : 0.5;
    const bestBid = bids.length > 0
      ? Math.max(...bids.map(b => parseFloat(b.price)))
      : 0.5;
    const liquidity = bids.slice(0, 5).reduce(
      (sum, b) => sum + parseFloat(b.size) * parseFloat(b.price),
      0
    );

    return { bestAsk, bestBid, liquidity };
  } catch (error) {
    return { bestAsk: 0.5, bestBid: 0.5, liquidity: 0 };
  }
}

/**
 * Extract token IDs from market data
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

  if (!yesTokenId && market.tokens && market.tokens.length >= 2) {
    const yesToken = market.tokens.find(t => t.outcome?.toLowerCase() === 'yes');
    const noToken = market.tokens.find(t => t.outcome?.toLowerCase() === 'no');
    yesTokenId = yesToken?.token_id || '';
    noTokenId = noToken?.token_id || '';
  }

  return { yesTokenId, noTokenId };
}

/**
 * Process a multi-outcome event for arbitrage analysis
 */
async function processEvent(eventData, clobClient) {
  // Skip events with only 1 market (binary, not multi-outcome)
  const markets = eventData.markets || [];
  if (markets.length < 2) return null;

  // Filter for active, non-closed markets
  const activeMarkets = markets.filter(m => m.active && !m.closed);
  if (activeMarkets.length < 2) return null;

  const event = new MultiOutcomeEvent(eventData);

  // Add each market/outcome
  for (const market of activeMarkets) {
    event.addMarket(market);
  }

  // Fetch live prices for each outcome
  for (let i = 0; i < event.markets.length; i++) {
    const market = event.markets[i];
    const rawMarket = activeMarkets[i];

    const { yesTokenId, noTokenId } = extractTokenIds(rawMarket);
    market.yesTokenId = yesTokenId;
    market.noTokenId = noTokenId;

    if (yesTokenId && clobClient) {
      const prices = await getBookPrices(yesTokenId, clobClient);
      market.yesPrice = prices.bestAsk;
      market.yesBid = prices.bestBid;
      market.yesLiquidity = prices.liquidity;
    }
  }

  event.lastUpdated = Date.now();
  return event;
}

/**
 * Run full arbitrage scan on multi-outcome events
 */
async function runArbitrageScan(clobClient, maxEvents = 50) {
  console.log('\n[ARB-ENGINE] ════════════════════════════════════════════════════');
  console.log('[ARB-ENGINE] Starting multi-outcome arbitrage scan...');
  console.log('[ARB-ENGINE] Looking for NegRisk / multi-outcome events where sum ≠ 1');

  const startTime = Date.now();
  const results = {
    events: [],
    opportunities: [],
    totalScanned: 0,
    multiOutcomeEvents: 0,
    withMispricing: 0,
    qualifyingOpportunities: 0,
    scanTime: 0,
    timestamp: Date.now(),
    errors: [],
  };

  try {
    // Fetch events
    const rawEvents = await fetchActiveEvents(maxEvents);
    results.totalScanned = rawEvents.length;

    // Process each event
    for (const eventData of rawEvents) {
      const markets = eventData.markets || [];
      if (markets.length < 2) continue; // Skip single-market events

      results.multiOutcomeEvents++;

      const event = await processEvent(eventData, clobClient);
      if (!event) continue;

      const analysis = event.getAnalysis();
      results.events.push(analysis);

      if (analysis.absoluteMispricing >= 0.01) {
        results.withMispricing++;
      }

      if (analysis.qualifies) {
        results.qualifyingOpportunities++;
        results.opportunities.push(analysis);
        console.log(`[ARB-ENGINE] 🎯 OPPORTUNITY: ${analysis.title}`);
        console.log(`[ARB-ENGINE]    Outcomes: ${analysis.numOutcomes}, Mispricing: ${(analysis.mispricing * 100).toFixed(2)}%`);
        console.log(`[ARB-ENGINE]    Profit after fees: ${(analysis.profitAfterFees * 100).toFixed(2)}%`);
      }

      // Rate limiting
      await new Promise(r => setTimeout(r, 50));
    }

    // Sort by mispricing
    results.events.sort((a, b) => b.absoluteMispricing - a.absoluteMispricing);
    results.opportunities.sort((a, b) => b.profitAfterFees - a.profitAfterFees);

  } catch (error) {
    results.errors.push(error.message);
    console.error('[ARB-ENGINE] Scan error:', error.message);
  }

  results.scanTime = Date.now() - startTime;

  console.log('[ARB-ENGINE] ────────────────────────────────────────────────────');
  console.log(`[ARB-ENGINE] Scan complete in ${results.scanTime}ms`);
  console.log(`[ARB-ENGINE] Total events: ${results.totalScanned}`);
  console.log(`[ARB-ENGINE] Multi-outcome events: ${results.multiOutcomeEvents}`);
  console.log(`[ARB-ENGINE] With mispricing (>1%): ${results.withMispricing}`);
  console.log(`[ARB-ENGINE] Qualifying opportunities: ${results.qualifyingOpportunities}`);
  console.log('[ARB-ENGINE] ════════════════════════════════════════════════════\n');

  return results;
}

/**
 * Calculate Bregman divergence (KL divergence for LMSR)
 * D(μ||θ) = Σ μ_i × ln(μ_i / p_i(θ))
 *
 * For practical purposes with multi-outcome markets:
 * This measures how far current prices are from valid probabilities
 */
function calculateBregmanDivergence(prices) {
  const n = prices.length;
  const uniform = 1 / n; // Fair prices if all outcomes equally likely

  let divergence = 0;
  for (const p of prices) {
    if (p > 0 && p < 1) {
      divergence += uniform * Math.log(uniform / p);
    }
  }
  return divergence;
}

/**
 * Profit guarantee formula from the article:
 * Profit ≥ D(μ̂||θ) - g(μ̂)
 *
 * For simple multi-outcome arbitrage:
 * - D(μ̂||θ) ≈ |1 - Σp_i| (maximum arbitrage)
 * - g(μ̂) ≈ 0 (we're not iterating, just detecting)
 * - So profit ≈ |1 - Σp_i| - fees
 */
function calculateProfitGuarantee(prices, feeRate = 0.02) {
  const sum = prices.reduce((a, b) => a + b, 0);
  const mispricing = Math.abs(1 - sum);
  const fees = prices.length * feeRate * 2;

  return {
    bregmanDivergence: mispricing, // Simplified for multi-outcome
    frankWolfeGap: 0, // No iteration needed for simple arbitrage
    grossProfit: mispricing,
    fees,
    guaranteedProfit: Math.max(0, mispricing - fees),
  };
}

// ============================================================================
// TYPE 2 ARBITRAGE: CROSS-MARKET DEPENDENCY DETECTION
// ============================================================================

/**
 * Cross-market arbitrage patterns:
 * 1. Temporal: "X by March" vs "X by June" - earlier deadline ≤ later deadline
 * 2. Threshold: "Price > $100" vs "Price > $50" - higher threshold ≤ lower threshold
 * 3. Subset: "Win state Y" vs "Win election" - subset event ≤ superset event
 */

// Common date patterns for temporal market detection
const DATE_PATTERNS = [
  /by\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{1,2})?,?\s*(\d{4})?/i,
  /before\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{1,2})?,?\s*(\d{4})?/i,
  /in\s+(Q[1-4])\s*(\d{4})?/i,
  /by\s+(Q[1-4])\s*(\d{4})?/i,
  /by\s+end\s+of\s+(\d{4})/i,
  /by\s+(20\d{2})/i,
];

// Threshold patterns for price/number markets
const THRESHOLD_PATTERNS = [
  /(?:above|over|exceed|reach|hit)\s*\$?([\d,]+(?:\.\d+)?)/i,
  /(?:below|under)\s*\$?([\d,]+(?:\.\d+)?)/i,
  />\s*\$?([\d,]+(?:\.\d+)?)/i,
  /<\s*\$?([\d,]+(?:\.\d+)?)/i,
  /at\s+least\s*\$?([\d,]+(?:\.\d+)?)/i,
];

const MONTH_ORDER = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Extract subject/entity from market question
 * Strips common question words to get the core subject
 */
function extractSubject(question) {
  if (!question) return '';

  // Remove common question prefixes
  let subject = question
    .replace(/^(will|can|does|is|are|has|have|do)\s+/i, '')
    .replace(/\?$/, '')
    .toLowerCase()
    .trim();

  // Remove date/time suffixes
  for (const pattern of DATE_PATTERNS) {
    subject = subject.replace(pattern, '');
  }

  // Remove threshold values
  for (const pattern of THRESHOLD_PATTERNS) {
    subject = subject.replace(pattern, '');
  }

  return subject.trim();
}

/**
 * Extract date/deadline from market question
 * Returns { month, day, year, quarter, raw } or null
 */
function extractDeadline(question) {
  if (!question) return null;

  for (const pattern of DATE_PATTERNS) {
    const match = question.match(pattern);
    if (match) {
      const raw = match[0];

      // Handle quarter format (Q1, Q2, etc.)
      if (match[1] && match[1].startsWith('Q')) {
        const quarter = parseInt(match[1][1]);
        const year = parseInt(match[2]) || new Date().getFullYear();
        const endMonth = quarter * 3; // Q1->3, Q2->6, Q3->9, Q4->12
        return { month: endMonth, day: 31, year, quarter, raw };
      }

      // Handle month format
      const month = MONTH_ORDER[match[1]?.toLowerCase()];
      if (month) {
        const day = parseInt(match[2]) || 31;
        const year = parseInt(match[3]) || new Date().getFullYear();
        return { month, day, year, quarter: null, raw };
      }

      // Handle year-only format
      const yearMatch = match[1]?.match(/^20\d{2}$/);
      if (yearMatch) {
        return { month: 12, day: 31, year: parseInt(match[1]), quarter: null, raw };
      }
    }
  }

  return null;
}

/**
 * Extract threshold value from market question
 * Returns { value, direction: 'above'|'below' } or null
 */
function extractThreshold(question) {
  if (!question) return null;

  const abovePatterns = [/(?:above|over|exceed|reach|hit|>|at\s+least)\s*\$?([\d,]+(?:\.\d+)?)/i];
  const belowPatterns = [/(?:below|under|<)\s*\$?([\d,]+(?:\.\d+)?)/i];

  for (const pattern of abovePatterns) {
    const match = question.match(pattern);
    if (match) {
      return { value: parseFloat(match[1].replace(/,/g, '')), direction: 'above' };
    }
  }

  for (const pattern of belowPatterns) {
    const match = question.match(pattern);
    if (match) {
      return { value: parseFloat(match[1].replace(/,/g, '')), direction: 'below' };
    }
  }

  return null;
}

/**
 * Compare two deadlines, returns: -1 if a < b, 0 if equal, 1 if a > b
 */
function compareDeadlines(a, b) {
  if (!a || !b) return 0;

  const dateA = new Date(a.year, a.month - 1, a.day);
  const dateB = new Date(b.year, b.month - 1, b.day);

  if (dateA < dateB) return -1;
  if (dateA > dateB) return 1;
  return 0;
}

/**
 * Calculate similarity score between two subjects (0-1)
 */
function subjectSimilarity(subjectA, subjectB) {
  if (!subjectA || !subjectB) return 0;

  const wordsA = new Set(subjectA.toLowerCase().split(/\s+/));
  const wordsB = new Set(subjectB.toLowerCase().split(/\s+/));

  // Stop words to ignore
  const stopWords = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by']);

  const filteredA = new Set([...wordsA].filter(w => !stopWords.has(w) && w.length > 2));
  const filteredB = new Set([...wordsB].filter(w => !stopWords.has(w) && w.length > 2));

  if (filteredA.size === 0 || filteredB.size === 0) return 0;

  const intersection = [...filteredA].filter(w => filteredB.has(w)).length;
  const union = new Set([...filteredA, ...filteredB]).size;

  return intersection / union; // Jaccard similarity
}

/**
 * Represents a cross-market dependency
 */
class CrossMarketDependency {
  constructor(marketA, marketB, type, reasoning) {
    this.marketA = marketA;
    this.marketB = marketB;
    this.type = type; // 'temporal', 'threshold', 'subset'
    this.reasoning = reasoning;
    this.expectedRelation = null; // 'A <= B', 'A >= B'
    this.actualPriceA = 0;
    this.actualPriceB = 0;
    this.violation = false;
    this.arbitrageProfit = 0;
    this.qualifies = false;
    this.reasons = [];
  }

  /**
   * Check if there's an arbitrage opportunity
   */
  evaluate() {
    const { priceA, priceB } = this;

    if (this.expectedRelation === 'A <= B') {
      // If A should be <= B, but A > B, there's an opportunity
      if (priceA > priceB) {
        this.violation = true;
        this.arbitrageProfit = priceA - priceB;
        this.reasons.push(`Expected P(A) ≤ P(B), but ${priceA.toFixed(3)} > ${priceB.toFixed(3)}`);
        this.reasons.push(`Strategy: Buy B, Sell A → profit ${(this.arbitrageProfit * 100).toFixed(2)}%`);
      }
    } else if (this.expectedRelation === 'A >= B') {
      // If A should be >= B, but A < B, there's an opportunity
      if (priceA < priceB) {
        this.violation = true;
        this.arbitrageProfit = priceB - priceA;
        this.reasons.push(`Expected P(A) ≥ P(B), but ${priceA.toFixed(3)} < ${priceB.toFixed(3)}`);
        this.reasons.push(`Strategy: Buy A, Sell B → profit ${(this.arbitrageProfit * 100).toFixed(2)}%`);
      }
    }

    // Check if profit exceeds fees
    const fees = config.feeRate * 4; // Buy and sell on both sides
    const profitAfterFees = this.arbitrageProfit - fees;

    if (this.violation && profitAfterFees > 0) {
      this.qualifies = true;
      this.profitAfterFees = profitAfterFees;
      this.reasons.push(`✓ Net profit after ${(fees * 100).toFixed(1)}% fees: ${(profitAfterFees * 100).toFixed(2)}%`);
    } else if (this.violation) {
      this.profitAfterFees = profitAfterFees;
      this.reasons.push(`Profit wiped by fees: ${(this.arbitrageProfit * 100).toFixed(2)}% - ${(fees * 100).toFixed(1)}% = ${(profitAfterFees * 100).toFixed(2)}%`);
    }

    return this;
  }

  get priceA() { return this.actualPriceA; }
  set priceA(v) { this.actualPriceA = v; }

  get priceB() { return this.actualPriceB; }
  set priceB(v) { this.actualPriceB = v; }

  toJSON() {
    return {
      type: this.type,
      marketA: {
        id: this.marketA.id,
        question: this.marketA.question,
        price: this.actualPriceA,
      },
      marketB: {
        id: this.marketB.id,
        question: this.marketB.question,
        price: this.actualPriceB,
      },
      expectedRelation: this.expectedRelation,
      reasoning: this.reasoning,
      violation: this.violation,
      arbitrageProfit: this.arbitrageProfit,
      profitAfterFees: this.profitAfterFees || 0,
      qualifies: this.qualifies,
      reasons: this.reasons,
    };
  }
}

/**
 * Find temporal dependencies between markets
 * "X by March" should have P <= "X by June"
 */
function findTemporalDependencies(markets) {
  const dependencies = [];
  const marketsWithDeadlines = [];

  // Extract deadlines from all markets
  for (const market of markets) {
    const deadline = extractDeadline(market.question);
    const subject = extractSubject(market.question);

    if (deadline && subject) {
      marketsWithDeadlines.push({ market, deadline, subject });
    }
  }

  // Find pairs with similar subjects but different deadlines
  for (let i = 0; i < marketsWithDeadlines.length; i++) {
    for (let j = i + 1; j < marketsWithDeadlines.length; j++) {
      const a = marketsWithDeadlines[i];
      const b = marketsWithDeadlines[j];

      // Check if subjects are similar enough
      const similarity = subjectSimilarity(a.subject, b.subject);
      if (similarity < 0.5) continue; // Need at least 50% word overlap

      // Check if deadlines are different
      const cmp = compareDeadlines(a.deadline, b.deadline);
      if (cmp === 0) continue; // Same deadline, no dependency

      // Create dependency: earlier deadline should have lower probability
      const earlier = cmp < 0 ? a : b;
      const later = cmp < 0 ? b : a;

      const dep = new CrossMarketDependency(
        earlier.market,
        later.market,
        'temporal',
        `"${earlier.deadline.raw}" must happen before "${later.deadline.raw}" for same event`
      );
      dep.expectedRelation = 'A <= B'; // P(earlier) <= P(later)

      dependencies.push(dep);
    }
  }

  return dependencies;
}

/**
 * Find threshold dependencies between markets
 * "Price > $100" should have P <= "Price > $50"
 */
function findThresholdDependencies(markets) {
  const dependencies = [];
  const marketsWithThresholds = [];

  // Extract thresholds from all markets
  for (const market of markets) {
    const threshold = extractThreshold(market.question);
    const subject = extractSubject(market.question);

    if (threshold && subject) {
      marketsWithThresholds.push({ market, threshold, subject });
    }
  }

  // Find pairs with similar subjects but different thresholds
  for (let i = 0; i < marketsWithThresholds.length; i++) {
    for (let j = i + 1; j < marketsWithThresholds.length; j++) {
      const a = marketsWithThresholds[i];
      const b = marketsWithThresholds[j];

      // Check if subjects are similar enough
      const similarity = subjectSimilarity(a.subject, b.subject);
      if (similarity < 0.5) continue;

      // Check if same direction (both "above" or both "below")
      if (a.threshold.direction !== b.threshold.direction) continue;

      // Check if thresholds are different
      if (Math.abs(a.threshold.value - b.threshold.value) < 0.01) continue;

      if (a.threshold.direction === 'above') {
        // Higher threshold should have lower probability
        const higher = a.threshold.value > b.threshold.value ? a : b;
        const lower = a.threshold.value > b.threshold.value ? b : a;

        const dep = new CrossMarketDependency(
          higher.market,
          lower.market,
          'threshold',
          `Reaching ${higher.threshold.value} requires reaching ${lower.threshold.value} first`
        );
        dep.expectedRelation = 'A <= B'; // P(higher threshold) <= P(lower threshold)

        dependencies.push(dep);
      } else {
        // For "below" thresholds, lower threshold should have lower probability
        const lower = a.threshold.value < b.threshold.value ? a : b;
        const higher = a.threshold.value < b.threshold.value ? b : a;

        const dep = new CrossMarketDependency(
          lower.market,
          higher.market,
          'threshold',
          `Going below ${lower.threshold.value} requires going below ${higher.threshold.value} first`
        );
        dep.expectedRelation = 'A <= B';

        dependencies.push(dep);
      }
    }
  }

  return dependencies;
}

/**
 * Scan for cross-market dependencies (Type 2 arbitrage)
 */
async function findCrossMarketArbitrage(markets) {
  console.log('\n[ARB-TYPE2] ════════════════════════════════════════════════════');
  console.log('[ARB-TYPE2] Starting cross-market dependency scan...');
  console.log(`[ARB-TYPE2] Analyzing ${markets.length} markets for logical relationships`);

  const startTime = Date.now();

  // Find all types of dependencies
  const temporalDeps = findTemporalDependencies(markets);
  const thresholdDeps = findThresholdDependencies(markets);

  const allDependencies = [...temporalDeps, ...thresholdDeps];

  console.log(`[ARB-TYPE2] Found ${temporalDeps.length} temporal dependencies`);
  console.log(`[ARB-TYPE2] Found ${thresholdDeps.length} threshold dependencies`);

  // Evaluate each dependency for arbitrage
  const opportunities = [];

  for (const dep of allDependencies) {
    dep.evaluate();

    if (dep.qualifies) {
      opportunities.push(dep);
      console.log(`[ARB-TYPE2] 🎯 OPPORTUNITY [${dep.type}]:`);
      console.log(`[ARB-TYPE2]    A: ${dep.marketA.question?.slice(0, 50)}...`);
      console.log(`[ARB-TYPE2]    B: ${dep.marketB.question?.slice(0, 50)}...`);
      console.log(`[ARB-TYPE2]    Profit: ${(dep.profitAfterFees * 100).toFixed(2)}%`);
    }
  }

  const scanTime = Date.now() - startTime;

  console.log('[ARB-TYPE2] ────────────────────────────────────────────────────');
  console.log(`[ARB-TYPE2] Scan complete in ${scanTime}ms`);
  console.log(`[ARB-TYPE2] Total dependencies found: ${allDependencies.length}`);
  console.log(`[ARB-TYPE2] Violations detected: ${allDependencies.filter(d => d.violation).length}`);
  console.log(`[ARB-TYPE2] Qualifying opportunities: ${opportunities.length}`);
  console.log('[ARB-TYPE2] ════════════════════════════════════════════════════\n');

  return {
    dependencies: allDependencies.map(d => d.toJSON()),
    opportunities: opportunities.map(d => d.toJSON()),
    stats: {
      totalMarkets: markets.length,
      temporalDependencies: temporalDeps.length,
      thresholdDependencies: thresholdDeps.length,
      violations: allDependencies.filter(d => d.violation).length,
      qualifyingOpportunities: opportunities.length,
      scanTime,
    },
    timestamp: Date.now(),
  };
}

// Export for use in server
export {
  MultiOutcomeEvent,
  fetchActiveEvents,
  processEvent,
  runArbitrageScan,
  calculateBregmanDivergence,
  calculateProfitGuarantee,
  config,
  // Type 2 exports
  CrossMarketDependency,
  findCrossMarketArbitrage,
  findTemporalDependencies,
  findThresholdDependencies,
  extractSubject,
  extractDeadline,
  extractThreshold,
};
