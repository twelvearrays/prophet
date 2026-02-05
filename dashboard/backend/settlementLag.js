/**
 * Settlement Lag Scanner (Type 3 Arbitrage)
 *
 * Detects markets where the outcome is effectively determined but
 * prices haven't locked to 0 or 1 yet.
 *
 * Example from paper: Assad remaining President of Syria
 * - Assad flees country (outcome determined: NO wins)
 * - Prices: YES = $0.30, NO = $0.30 (should be YES = $0, NO = $1)
 * - Arbitrage: Sell YES shares for $0.30, they resolve to $0
 *
 * Detection signals:
 * 1. Price-volume divergence (high volume, low price movement)
 * 2. Boundary rush (rapid movement toward 0 or 1)
 * 3. Large bid-ask spread near boundaries
 * 4. Market close date passed but not yet settled
 */

/**
 * Configuration for settlement lag detection
 */
const DEFAULT_CONFIG = {
  volumeMultiplierThreshold: 3,    // 3x average volume = suspicious
  priceChangeThreshold: 0.10,      // Less than 10% price change = suspicious
  boundaryThreshold: 0.15,         // Within 15% of 0 or 1
  velocityThreshold: 0.05,         // 5% per hour velocity
  minProfitThreshold: 0.05,        // Minimum 5% profit to flag
  settlementGracePeriodMs: 24 * 60 * 60 * 1000,  // 24 hours grace period
};

/**
 * Settlement Lag Scanner
 */
class SettlementLagScanner {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Scan markets for settlement lag opportunities
   *
   * @param {Array} markets - Array of market objects
   * @returns {Array} Opportunities found
   */
  scan(markets) {
    const opportunities = [];

    for (const market of markets) {
      const analysis = this.analyzeMarket(market);
      if (analysis.hasOpportunity) {
        opportunities.push(analysis);
      }
    }

    // Sort by profit potential
    opportunities.sort((a, b) => b.potentialProfit - a.potentialProfit);

    return opportunities;
  }

  /**
   * Analyze a single market for settlement lag
   *
   * @param {Object} market - Market data
   * @returns {Object} Analysis result
   */
  analyzeMarket(market) {
    const signals = [];
    let confidence = 0;

    // Signal 1: Price-volume divergence
    const pvSignal = this.detectPriceVolumeDivergence(market);
    if (pvSignal.detected) {
      signals.push(pvSignal);
      confidence += 25;
    }

    // Signal 2: Boundary rush
    const brSignal = this.detectBoundaryRush(market);
    if (brSignal.detected) {
      signals.push(brSignal);
      confidence += 30;
    }

    // Signal 3: Stale price near boundary
    const spSignal = this.detectStalePrice(market);
    if (spSignal.detected) {
      signals.push(spSignal);
      confidence += 20;
    }

    // Signal 4: Past resolution date
    const prSignal = this.detectPastResolution(market);
    if (prSignal.detected) {
      signals.push(prSignal);
      confidence += 35;
    }

    // Signal 5: Extreme bid-ask spread
    const baSignal = this.detectExtremeSpread(market);
    if (baSignal.detected) {
      signals.push(baSignal);
      confidence += 15;
    }

    // Determine opportunity
    const hasOpportunity = signals.length >= 2 && confidence >= 40;
    const expectedPrice = this.inferExpectedPrice(market, signals);
    const potentialProfit = Math.abs(market.price - expectedPrice);

    return {
      marketId: market.id,
      question: market.question,
      currentPrice: market.price,
      expectedPrice,
      potentialProfit,
      hasOpportunity: hasOpportunity && potentialProfit >= this.config.minProfitThreshold,
      confidence,
      signals,
      strategy: this.determineStrategy(market.price, expectedPrice),
      type: 'SETTLEMENT_LAG'
    };
  }

  /**
   * Signal 1: Price-volume divergence
   *
   * High trading volume with minimal price movement suggests
   * informed traders know the outcome.
   */
  detectPriceVolumeDivergence(market) {
    const recentVolume = market.volume24h || 0;
    const avgVolume = market.avgVolume7d || market.volume24h || 1;
    const priceChange = Math.abs((market.price || 0.5) - (market.price24hAgo || 0.5));

    const volumeRatio = recentVolume / avgVolume;
    const detected = volumeRatio > this.config.volumeMultiplierThreshold
      && priceChange < this.config.priceChangeThreshold;

    return {
      type: 'PRICE_VOLUME_DIVERGENCE',
      detected,
      details: {
        volumeRatio: volumeRatio.toFixed(2),
        priceChange: (priceChange * 100).toFixed(2) + '%',
        reason: detected
          ? `Volume ${volumeRatio.toFixed(1)}x normal with only ${(priceChange * 100).toFixed(1)}% price change`
          : null
      }
    };
  }

  /**
   * Signal 2: Boundary rush
   *
   * Rapid price movement toward 0 or 1 indicates traders
   * are correcting a known outcome.
   */
  detectBoundaryRush(market) {
    const price = market.price || 0.5;
    const velocity = market.priceVelocity1h || 0;

    // Moving rapidly toward 0
    const rushingToZero = price < this.config.boundaryThreshold
      && velocity < -this.config.velocityThreshold;

    // Moving rapidly toward 1
    const rushingToOne = price > (1 - this.config.boundaryThreshold)
      && velocity > this.config.velocityThreshold;

    const detected = rushingToZero || rushingToOne;

    return {
      type: 'BOUNDARY_RUSH',
      detected,
      details: {
        price: price.toFixed(4),
        velocity: (velocity * 100).toFixed(2) + '%/hr',
        direction: rushingToZero ? 'toward 0' : rushingToOne ? 'toward 1' : 'stable',
        reason: detected
          ? `Price at ${(price * 100).toFixed(1)}% moving ${Math.abs(velocity * 100).toFixed(1)}%/hr ${rushingToZero ? 'toward 0' : 'toward 1'}`
          : null
      }
    };
  }

  /**
   * Signal 3: Stale price near boundary
   *
   * Price stuck near but not at 0/1 for extended period
   * suggests market should have settled.
   */
  detectStalePrice(market) {
    const price = market.price || 0.5;
    const lastUpdate = market.lastTradeTimestamp || Date.now();
    const hoursSinceUpdate = (Date.now() - lastUpdate) / (1000 * 60 * 60);

    const nearBoundary = price < 0.10 || price > 0.90;
    const isStale = hoursSinceUpdate > 6;

    const detected = nearBoundary && isStale;

    return {
      type: 'STALE_PRICE',
      detected,
      details: {
        price: price.toFixed(4),
        hoursSinceUpdate: hoursSinceUpdate.toFixed(1),
        reason: detected
          ? `Price at ${(price * 100).toFixed(1)}% unchanged for ${hoursSinceUpdate.toFixed(1)} hours`
          : null
      }
    };
  }

  /**
   * Signal 4: Past resolution date
   *
   * Market's end date has passed but outcome not yet settled.
   */
  detectPastResolution(market) {
    const endDate = market.endDate ? new Date(market.endDate).getTime() : null;
    const now = Date.now();

    if (!endDate) {
      return { type: 'PAST_RESOLUTION', detected: false, details: {} };
    }

    const isPastEnd = now > endDate + this.config.settlementGracePeriodMs;
    const isNotSettled = !market.settled && market.price > 0.01 && market.price < 0.99;

    const detected = isPastEnd && isNotSettled;
    const daysPast = (now - endDate) / (1000 * 60 * 60 * 24);

    return {
      type: 'PAST_RESOLUTION',
      detected,
      details: {
        endDate: endDate ? new Date(endDate).toISOString() : null,
        daysPastEnd: daysPast.toFixed(1),
        settled: market.settled,
        reason: detected
          ? `Market ended ${daysPast.toFixed(1)} days ago but not settled (price: ${(market.price * 100).toFixed(1)}%)`
          : null
      }
    };
  }

  /**
   * Signal 5: Extreme bid-ask spread
   *
   * Large spread near boundaries suggests uncertainty or
   * lack of market makers willing to take the other side.
   */
  detectExtremeSpread(market) {
    const bestBid = market.bestBid || 0;
    const bestAsk = market.bestAsk || 1;
    const spread = bestAsk - bestBid;
    const midPrice = (bestBid + bestAsk) / 2;

    const nearBoundary = midPrice < 0.20 || midPrice > 0.80;
    const largeSpread = spread > 0.10;

    const detected = nearBoundary && largeSpread;

    return {
      type: 'EXTREME_SPREAD',
      detected,
      details: {
        bestBid: bestBid.toFixed(4),
        bestAsk: bestAsk.toFixed(4),
        spread: (spread * 100).toFixed(1) + '%',
        reason: detected
          ? `${(spread * 100).toFixed(1)}% spread near ${midPrice < 0.5 ? 'zero' : 'one'} boundary`
          : null
      }
    };
  }

  /**
   * Infer expected price based on signals
   */
  inferExpectedPrice(market, signals) {
    const price = market.price || 0.5;

    // If we have strong signals, infer the likely outcome
    const hasBoundaryRush = signals.some(s => s.type === 'BOUNDARY_RUSH');
    const hasPastResolution = signals.some(s => s.type === 'PAST_RESOLUTION');

    if (hasBoundaryRush || hasPastResolution) {
      // Assume price is moving to nearest boundary
      return price < 0.5 ? 0 : 1;
    }

    // Default: extrapolate from velocity
    const velocity = market.priceVelocity1h || 0;
    if (Math.abs(velocity) > 0.01) {
      return velocity < 0 ? 0 : 1;
    }

    // No clear signal
    return price < 0.5 ? 0 : 1;
  }

  /**
   * Determine trading strategy
   */
  determineStrategy(currentPrice, expectedPrice) {
    if (expectedPrice === 0) {
      return {
        action: 'SELL',
        side: 'YES',
        explanation: `Sell YES at $${currentPrice.toFixed(4)}, expected to resolve to $0`
      };
    } else if (expectedPrice === 1) {
      return {
        action: 'BUY',
        side: 'YES',
        explanation: `Buy YES at $${currentPrice.toFixed(4)}, expected to resolve to $1`
      };
    } else {
      return {
        action: 'WAIT',
        side: null,
        explanation: 'Outcome unclear, monitor for more signals'
      };
    }
  }

  /**
   * Calculate position sizing based on confidence
   */
  calculatePositionSize(opportunity, maxCapital = 1000) {
    const { confidence, potentialProfit, minLiquidity } = opportunity;

    // Base on Kelly Criterion approximation
    // f* = (p*b - q) / b where p = win prob, q = 1-p, b = odds
    // Simplified: position = confidence * expectedValue

    const confidenceFactor = confidence / 100;
    const profitFactor = Math.min(potentialProfit / 0.20, 1);  // Cap at 20% profit

    let positionSize = maxCapital * confidenceFactor * profitFactor * 0.5;  // 50% Kelly

    // Don't exceed liquidity
    if (minLiquidity) {
      positionSize = Math.min(positionSize, minLiquidity * 0.1);
    }

    return Math.round(positionSize);
  }
}

/**
 * Singleton instance
 */
const defaultScanner = new SettlementLagScanner();

/**
 * Quick scan function
 */
function scanSettlementLag(markets, config = {}) {
  const scanner = Object.keys(config).length > 0
    ? new SettlementLagScanner(config)
    : defaultScanner;
  return scanner.scan(markets);
}

export {
  SettlementLagScanner,
  scanSettlementLag,
  DEFAULT_CONFIG
};
