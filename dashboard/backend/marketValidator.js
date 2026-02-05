/**
 * Market Validator for Polymarket Arbitrage
 *
 * Determines if a market qualifies for Type 1 arbitrage.
 * Type 1 requires outcomes that are:
 * 1. MUTUALLY EXCLUSIVE (exactly one can be TRUE)
 * 2. EXHAUSTIVE (one MUST be TRUE)
 *
 * Based on: "The Math Needed for Trading on Polymarket" - Kroer et al.
 */

/**
 * Date patterns for temporal deadline detection
 */
const MONTH_NAMES = '(january|february|march|april|may|june|july|august|september|october|november|december)';

const DATE_PATTERNS = [
  // "by March", "by February 28"
  new RegExp(`by\\s+${MONTH_NAMES}`, 'i'),
  // "by Q1", "by Q4 2025"
  /by\s+(Q[1-4])/i,
  // "by end of 2024"
  /by\s+end\s+of\s+\d{4}/i,
  // "by 2025"
  /by\s+\d{4}/i,
  // "March 31, 2025" - full date with year
  new RegExp(`${MONTH_NAMES}\\s+\\d{1,2},?\\s*\\d{4}`, 'i'),
  // "February 28", "March 31" - month + day without year
  new RegExp(`^${MONTH_NAMES}\\s+\\d{1,2}$`, 'i'),
  // Looser: contains "Month Day" anywhere
  new RegExp(`${MONTH_NAMES}\\s+\\d{1,2}(?:\\s|$|,)`, 'i'),
];

/**
 * Patterns indicating the event title is about temporal deadlines
 */
const TEMPORAL_TITLE_PATTERNS = [
  /\bby\s*\.{2,}\??$/i,        // "by...?"
  /\bby\s+when/i,              // "by when"
  new RegExp(`by\\s+${MONTH_NAMES}`, 'i'),
  /by\s+(Q[1-4])/i,
  /by\s+\d{4}/i,
];

/**
 * Patterns indicating independent (non-exclusive) events
 */
const INDEPENDENT_EVENT_PATTERNS = [
  /what will happen/i,
  /what happens/i,
  /which.*will happen/i,
  /things that will/i,
  /events.*before/i,
  /predictions for/i,
  /will any of/i,
  /how many.*will/i,
  /which.*qualify/i,
  /which.*will make/i,
  /how many.*qualify/i,
];

/**
 * Category keywords for detecting unrelated outcomes
 */
const CATEGORY_KEYWORDS = {
  music: ['album', 'song', 'release', 'drake', 'rihanna', 'carti', 'music', 'artist', 'tour', 'concert'],
  politics: ['president', 'election', 'trump', 'biden', 'congress', 'vote', 'political', 'governor', 'senate'],
  war: ['war', 'invasion', 'military', 'ceasefire', 'russia', 'ukraine', 'china', 'taiwan', 'capture', 'troops'],
  tech: ['gpt', 'ai', 'released', 'launch', 'apple', 'google', 'tesla', 'openai', 'microsoft'],
  crypto: ['bitcoin', 'btc', 'eth', 'crypto', 'ethereum', 'solana'],
  religion: ['jesus', 'christ', 'god', 'religious', 'pope'],
  sports: ['championship', 'world cup', 'super bowl', 'nba', 'nfl', 'playoffs', 'finals'],
  entertainment: ['movie', 'film', 'oscar', 'grammy', 'emmy', 'series', 'show'],
};

/**
 * Patterns indicating valid mutually exclusive markets
 */
const VALID_WINNER_PATTERNS = [
  /who will win/i,
  /which.*will win/i,
  /winner of/i,
  /next.*president/i,
  /next.*prime minister/i,
  /next.*actor/i,              // "Next James Bond actor?"
  /next.*host/i,               // "Next host of..."
  /next.*ceo/i,                // "Next CEO of..."
  /next.*champion/i,           // "Next world champion"
  /what place will/i,
  /what will.*finish/i,
  /where will.*finish/i,
  /who will be/i,
  /which.*nominated/i,
  // Award/recognition patterns (exactly one winner)
  /of the year/i,              // "NFL Protector of the Year", "MVP of the Year"
  /player of/i,                // "Player of the Month"
  /mvp/i,                      // "Super Bowl MVP"
  /best\s+(picture|actor|actress|director|film)/i,  // Oscars
  /golden globe/i,
  /grammy/i,
  /ballon d'or/i,
  /heisman/i,
  /rookie of/i,
  /champion$/i,                // "World Champion"
  /\d+(st|nd|rd|th)\s+pick/i,  // "1st pick", "2nd pick" (draft)
];

/**
 * Patterns indicating cumulative/threshold markets (NOT mutually exclusive)
 */
const THRESHOLD_PATTERNS = [
  /reach\s*\$?\d/i,
  /hit\s*\$?\d/i,
  /exceed\s*\$?\d/i,
  /above\s*\$?\d/i,
  /over\s*\$?\d/i,
  /\$\d+k?\+/i,
];

const MORE_THAN_PATTERNS = [
  /more than \d/i,
  /at least \d/i,
  /\d\+ /i,
  /\d or more/i,
];

/**
 * Check if market outcomes are temporal deadlines
 * e.g., "by March" vs "by December" - NOT mutually exclusive
 */
function isTemporalDeadlineEvent(eventData, markets) {
  const eventTitle = (eventData?.title || '').toLowerCase();

  // Strong signal: Event title contains temporal patterns
  for (const pattern of TEMPORAL_TITLE_PATTERNS) {
    if (pattern.test(eventTitle)) {
      return { isTemporal: true, reason: 'Event title indicates temporal deadline' };
    }
  }

  // Check outcome titles for date patterns
  let temporalCount = 0;
  for (const market of markets) {
    const title = (market.groupItemTitle || market.question || '').trim();
    for (const pattern of DATE_PATTERNS) {
      if (pattern.test(title)) {
        temporalCount++;
        break;
      }
    }
  }

  // If ≥50% of outcomes have date patterns, it's temporal
  if (temporalCount >= markets.length * 0.5) {
    return {
      isTemporal: true,
      reason: `${temporalCount}/${markets.length} outcomes have date patterns`
    };
  }

  return { isTemporal: false };
}

/**
 * Check if market has independent (non-mutually-exclusive) events
 * e.g., "What will happen before GTA VI?" with unrelated outcomes
 */
function isIndependentEventsMarket(eventData, markets) {
  const title = (eventData?.title || '').toLowerCase();

  // Check title patterns
  for (const pattern of INDEPENDENT_EVENT_PATTERNS) {
    if (pattern.test(title)) {
      return {
        isIndependent: true,
        reason: 'Event title indicates independent events'
      };
    }
  }

  // Check if outcomes span multiple unrelated categories
  const categories = new Set();
  for (const market of markets) {
    const outcomeTitle = (market.groupItemTitle || market.question || '').toLowerCase();
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (keywords.some(kw => outcomeTitle.includes(kw))) {
        categories.add(category);
        break;
      }
    }
  }

  // 3+ unrelated categories = definitely independent events
  if (categories.size >= 3) {
    return {
      isIndependent: true,
      reason: `Outcomes span ${categories.size} unrelated categories: ${[...categories].join(', ')}`
    };
  }

  return { isIndependent: false };
}

/**
 * Check if market has cumulative/threshold outcomes
 * e.g., "Will BTC reach $100k/$150k/$200k?" - reaching higher means reaching lower
 * Also catches ">$1B", ">$2B" style outcomes
 */
function isCumulativeThresholdMarket(eventData, markets) {
  const title = (eventData?.title || '').toLowerCase();

  // CRITICAL: Check if OUTCOMES have ">" or "<" threshold patterns
  // e.g., ">$1B", ">$2B", ">$3B" - these are cumulative, NOT mutually exclusive!
  let gtCount = 0;  // Greater than count
  let ltCount = 0;  // Less than count
  const thresholdValues = [];

  for (const market of markets) {
    const outcomeTitle = (market.groupItemTitle || market.question || '').toLowerCase();

    // Match ">$1B", ">$2B", ">1B", ">2B", "> $1B" patterns
    const gtMatch = outcomeTitle.match(/^[>]\s*\$?([\d.]+)\s*(b|m|k|billion|million|thousand)?/i);
    if (gtMatch) {
      gtCount++;
      let value = parseFloat(gtMatch[1]);
      const suffix = (gtMatch[2] || '').toLowerCase();
      if (suffix === 'b' || suffix === 'billion') value *= 1e9;
      else if (suffix === 'm' || suffix === 'million') value *= 1e6;
      else if (suffix === 'k' || suffix === 'thousand') value *= 1e3;
      thresholdValues.push(value);
    }

    // Match "<$1B" patterns
    const ltMatch = outcomeTitle.match(/^[<]\s*\$?([\d.]+)\s*(b|m|k|billion|million|thousand)?/i);
    if (ltMatch) {
      ltCount++;
    }
  }

  // If most outcomes are ">" thresholds, it's cumulative
  if (gtCount >= 2 && gtCount >= markets.length * 0.5) {
    return {
      isCumulative: true,
      reason: `${gtCount}/${markets.length} outcomes are ">" thresholds (cumulative, not mutually exclusive)`
    };
  }

  // Check if title indicates threshold market
  if (THRESHOLD_PATTERNS.some(p => p.test(title))) {
    // Extract numeric values from outcomes
    const values = [];
    for (const market of markets) {
      const outcomeTitle = (market.groupItemTitle || market.question || '').toLowerCase();
      const matches = outcomeTitle.match(/\$?([\d,]+)k?/g);
      if (matches) {
        for (const m of matches) {
          const num = parseFloat(m.replace(/[$,k]/gi, '')) * (m.toLowerCase().includes('k') ? 1000 : 1);
          if (!isNaN(num) && num > 0) values.push(num);
        }
      }
    }

    // Multiple distinct threshold values = cumulative
    const uniqueValues = [...new Set(values)];
    if (uniqueValues.length >= 2) {
      return {
        isCumulative: true,
        reason: `Multiple threshold values detected: ${uniqueValues.sort((a,b) => a-b).join(', ')}`
      };
    }
  }

  // Check for "more than X" patterns
  let moreCount = 0;
  for (const market of markets) {
    const outcomeTitle = (market.groupItemTitle || market.question || '').toLowerCase();
    if (MORE_THAN_PATTERNS.some(p => p.test(outcomeTitle))) {
      moreCount++;
    }
  }

  if (moreCount >= 2) {
    return {
      isCumulative: true,
      reason: `${moreCount} outcomes use "more than" / "at least" patterns`
    };
  }

  return { isCumulative: false };
}

/**
 * Check if market is a valid "winner" market (definitely mutually exclusive)
 */
function isValidWinnerMarket(eventData) {
  const title = (eventData?.title || '').toLowerCase();

  for (const pattern of VALID_WINNER_PATTERNS) {
    if (pattern.test(title)) {
      return { isWinner: true, reason: `Title matches winner pattern` };
    }
  }

  return { isWinner: false };
}

/**
 * Master validation: Is this a valid Type 1 arbitrage market?
 *
 * @param {Object} eventData - Event data from Polymarket
 * @param {Array} markets - Array of market outcomes
 * @returns {Object} { isValid: boolean, reason: string, confidence: string }
 */
function validateType1Market(eventData, markets) {
  const title = eventData?.title || 'Unknown';

  // Minimum 2 outcomes required
  if (markets.length < 2) {
    return {
      isValid: false,
      reason: 'Less than 2 outcomes',
      confidence: 'CERTAIN'
    };
  }

  // Check 1: Temporal deadlines (REJECT)
  const temporalCheck = isTemporalDeadlineEvent(eventData, markets);
  if (temporalCheck.isTemporal) {
    return {
      isValid: false,
      reason: `Temporal deadline market: ${temporalCheck.reason}`,
      confidence: 'HIGH',
      type: 'TEMPORAL'
    };
  }

  // Check 2: Independent events (REJECT)
  const independentCheck = isIndependentEventsMarket(eventData, markets);
  if (independentCheck.isIndependent) {
    return {
      isValid: false,
      reason: `Independent events: ${independentCheck.reason}`,
      confidence: 'HIGH',
      type: 'INDEPENDENT'
    };
  }

  // Check 3: Cumulative thresholds (REJECT)
  const cumulativeCheck = isCumulativeThresholdMarket(eventData, markets);
  if (cumulativeCheck.isCumulative) {
    return {
      isValid: false,
      reason: `Cumulative threshold: ${cumulativeCheck.reason}`,
      confidence: 'HIGH',
      type: 'CUMULATIVE'
    };
  }

  // Check 4: Valid winner market (ACCEPT with high confidence)
  const winnerCheck = isValidWinnerMarket(eventData);
  if (winnerCheck.isWinner) {
    return {
      isValid: true,
      reason: `Valid winner market: ${winnerCheck.reason}`,
      confidence: 'HIGH',
      type: 'WINNER'
    };
  }

  // Default: Accept but with lower confidence
  // Markets that passed all negative checks might still be valid
  return {
    isValid: true,
    reason: 'Passed all exclusion checks (no clear pattern)',
    confidence: 'MEDIUM',
    type: 'UNKNOWN'
  };
}

/**
 * Post-price validation: Check if sum makes sense
 * Sum >> 1 indicates non-mutually-exclusive outcomes
 *
 * @param {number} totalYesPrice - Sum of all YES prices
 * @param {number} numOutcomes - Number of outcomes
 * @returns {Object} { isValid: boolean, reason: string }
 */
function validatePriceSum(totalYesPrice, numOutcomes) {
  // Sum > 2.0 is almost certainly NOT mutually exclusive
  if (totalYesPrice > 2.0) {
    return {
      isValid: false,
      reason: `Sum ${totalYesPrice.toFixed(2)} >> 1 indicates non-mutually-exclusive outcomes`
    };
  }

  // Sum > 1.5 is suspicious for markets with few outcomes
  if (totalYesPrice > 1.5 && numOutcomes <= 3) {
    return {
      isValid: false,
      reason: `Sum ${totalYesPrice.toFixed(2)} too high for ${numOutcomes}-outcome market`
    };
  }

  // Sum < 0.3 is suspicious (maybe outcomes are missing)
  if (totalYesPrice < 0.3 && numOutcomes >= 3) {
    return {
      isValid: false,
      reason: `Sum ${totalYesPrice.toFixed(2)} too low - outcomes may be missing`
    };
  }

  return { isValid: true };
}

export {
  validateType1Market,
  validatePriceSum,
  isTemporalDeadlineEvent,
  isIndependentEventsMarket,
  isCumulativeThresholdMarket,
  isValidWinnerMarket,
  // Export patterns for testing
  DATE_PATTERNS,
  TEMPORAL_TITLE_PATTERNS,
  INDEPENDENT_EVENT_PATTERNS,
  VALID_WINNER_PATTERNS,
};
