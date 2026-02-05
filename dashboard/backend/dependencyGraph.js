/**
 * Dependency Graph for Cross-Market Arbitrage (Type 2)
 *
 * Builds and analyzes logical relationships between markets.
 * Detects constraint violations that create arbitrage opportunities.
 *
 * Dependency Types:
 * 1. Temporal: "X by March" → "X by June" (earlier implies later)
 * 2. Threshold: "X > $100" → "X > $50" (higher implies lower)
 * 3. Subset: "Team A wins division" → "Team A makes playoffs"
 * 4. Mutual Exclusion: "A wins" XOR "B wins"
 *
 * Based on: Cross-market dependency analysis from Kroer et al.
 */

/**
 * Month name to number mapping
 */
const MONTH_MAP = {
  'january': 1, 'jan': 1,
  'february': 2, 'feb': 2,
  'march': 3, 'mar': 3,
  'april': 4, 'apr': 4,
  'may': 5,
  'june': 6, 'jun': 6,
  'july': 7, 'jul': 7,
  'august': 8, 'aug': 8,
  'september': 9, 'sep': 9, 'sept': 9,
  'october': 10, 'oct': 10,
  'november': 11, 'nov': 11,
  'december': 12, 'dec': 12,
};

/**
 * Quarter to month mapping (end of quarter)
 */
const QUARTER_MAP = {
  'q1': 3, 'q2': 6, 'q3': 9, 'q4': 12
};

/**
 * Dependency Edge types
 */
const EdgeType = {
  TEMPORAL: 'TEMPORAL',
  THRESHOLD: 'THRESHOLD',
  SUBSET: 'SUBSET',
  MUTUAL_EXCLUSION: 'MUTUAL_EXCLUSION'
};

/**
 * Relation types
 */
const Relation = {
  IMPLIES: 'IMPLIES',        // A=true → B=true
  EXCLUDES: 'EXCLUDES',      // A=true → B=false
  EQUIVALENT: 'EQUIVALENT'   // A=true ↔ B=true
};

/**
 * Market node in dependency graph
 */
class MarketNode {
  constructor(market) {
    this.id = market.id || market.conditionId;
    this.question = market.question || market.groupItemTitle || '';
    this.price = market.price || market.outcomePrices?.[0] || 0.5;
    this.liquidity = market.liquidity || 0;
    this.slug = market.slug || '';

    // Parsed features
    this.subject = this.extractSubject();
    this.deadline = this.extractDeadline();
    this.threshold = this.extractThreshold();
  }

  /**
   * Extract the main subject from the question
   * "Will BTC reach $100k by March?" → "btc reach"
   */
  extractSubject() {
    let text = this.question.toLowerCase();

    // Remove common prefixes
    text = text.replace(/^(will|when will|if|whether)\s+/i, '');

    // Remove deadline phrases
    text = text.replace(/\s+by\s+.+$/i, '');
    text = text.replace(/\s+before\s+.+$/i, '');
    text = text.replace(/\s+in\s+\d{4}$/i, '');

    // Remove threshold phrases
    text = text.replace(/\s+(reach|hit|exceed|above|below)\s+\$?[\d,]+k?/i, '');

    // Clean up
    text = text.replace(/[?!.,]/g, '').trim();

    return text;
  }

  /**
   * Extract deadline from question
   * Returns: { year, month, day } or null
   */
  extractDeadline() {
    const text = this.question.toLowerCase();

    // Pattern: "by March 31, 2025" or "by March 2025"
    const fullDateMatch = text.match(/by\s+(\w+)\s+(\d{1,2})?,?\s*(\d{4})/i);
    if (fullDateMatch) {
      const month = MONTH_MAP[fullDateMatch[1].toLowerCase()];
      const day = fullDateMatch[2] ? parseInt(fullDateMatch[2]) : 28;
      const year = parseInt(fullDateMatch[3]);
      if (month) {
        return { year, month, day, raw: fullDateMatch[0] };
      }
    }

    // Pattern: "by Q1 2025"
    const quarterMatch = text.match(/by\s+(q[1-4])\s*(\d{4})?/i);
    if (quarterMatch) {
      const month = QUARTER_MAP[quarterMatch[1].toLowerCase()];
      const year = quarterMatch[2] ? parseInt(quarterMatch[2]) : new Date().getFullYear();
      return { year, month, day: 28, raw: quarterMatch[0] };
    }

    // Pattern: "by end of 2024"
    const endOfYearMatch = text.match(/by\s+end\s+of\s+(\d{4})/i);
    if (endOfYearMatch) {
      return { year: parseInt(endOfYearMatch[1]), month: 12, day: 31, raw: endOfYearMatch[0] };
    }

    // Pattern: Just month name (assume current/next year)
    const monthOnlyMatch = text.match(/by\s+(\w+)(?:\s+(\d{1,2}))?/i);
    if (monthOnlyMatch) {
      const month = MONTH_MAP[monthOnlyMatch[1].toLowerCase()];
      if (month) {
        const day = monthOnlyMatch[2] ? parseInt(monthOnlyMatch[2]) : 28;
        const currentYear = new Date().getFullYear();
        const currentMonth = new Date().getMonth() + 1;
        const year = month >= currentMonth ? currentYear : currentYear + 1;
        return { year, month, day, raw: monthOnlyMatch[0] };
      }
    }

    return null;
  }

  /**
   * Extract threshold value from question
   * "Will BTC reach $100k?" → { value: 100000, direction: 'above' }
   */
  extractThreshold() {
    const text = this.question.toLowerCase();

    // Pattern: "reach/hit/exceed $100k" or "above $100k"
    const aboveMatch = text.match(/(reach|hit|exceed|above|over)\s+\$?([\d,]+)k?/i);
    if (aboveMatch) {
      let value = parseFloat(aboveMatch[2].replace(/,/g, ''));
      if (aboveMatch[0].toLowerCase().includes('k')) {
        value *= 1000;
      }
      return { value, direction: 'above', raw: aboveMatch[0] };
    }

    // Pattern: "below $50k" or "under $50k"
    const belowMatch = text.match(/(below|under|less than)\s+\$?([\d,]+)k?/i);
    if (belowMatch) {
      let value = parseFloat(belowMatch[2].replace(/,/g, ''));
      if (belowMatch[0].toLowerCase().includes('k')) {
        value *= 1000;
      }
      return { value, direction: 'below', raw: belowMatch[0] };
    }

    return null;
  }

  /**
   * Convert deadline to comparable timestamp
   */
  getDeadlineTimestamp() {
    if (!this.deadline) return null;
    return new Date(this.deadline.year, this.deadline.month - 1, this.deadline.day).getTime();
  }
}

/**
 * Dependency edge between two markets
 */
class DependencyEdge {
  constructor(nodeA, nodeB, type, relation) {
    this.from = nodeA;
    this.to = nodeB;
    this.type = type;
    this.relation = relation;

    // Computed properties
    this.expectedConstraint = this.computeConstraint();
    this.violation = null;
    this.arbitrageProfit = 0;
  }

  /**
   * Compute expected price constraint
   */
  computeConstraint() {
    if (this.relation === Relation.IMPLIES) {
      // A implies B: P(A) ≤ P(B)
      return 'P(A) <= P(B)';
    } else if (this.relation === Relation.EXCLUDES) {
      // A excludes B: P(A) + P(B) ≤ 1
      return 'P(A) + P(B) <= 1';
    } else if (this.relation === Relation.EQUIVALENT) {
      // A equivalent B: P(A) = P(B)
      return 'P(A) = P(B)';
    }
    return null;
  }

  /**
   * Check if constraint is violated and compute arbitrage
   */
  evaluate(feeRate = 0.02) {
    const priceA = this.from.price;
    const priceB = this.to.price;

    if (this.relation === Relation.IMPLIES) {
      // P(A) should be ≤ P(B)
      if (priceA > priceB) {
        this.violation = {
          actual: `P(A)=${priceA.toFixed(4)} > P(B)=${priceB.toFixed(4)}`,
          difference: priceA - priceB
        };
        // Arbitrage: SELL A (overpriced), BUY B (underpriced)
        this.arbitrageProfit = priceA - priceB;
        this.strategy = {
          action: 'SELL_A_BUY_B',
          sell: { market: this.from, side: 'YES', price: priceA },
          buy: { market: this.to, side: 'YES', price: priceB }
        };
      }
    } else if (this.relation === Relation.EXCLUDES) {
      // P(A) + P(B) should be ≤ 1
      const sum = priceA + priceB;
      if (sum > 1) {
        this.violation = {
          actual: `P(A)+P(B)=${sum.toFixed(4)} > 1`,
          difference: sum - 1
        };
        // Arbitrage: SELL both
        this.arbitrageProfit = sum - 1;
        this.strategy = {
          action: 'SELL_BOTH',
          sellA: { market: this.from, side: 'YES', price: priceA },
          sellB: { market: this.to, side: 'YES', price: priceB }
        };
      }
    }

    // Apply fees
    if (this.arbitrageProfit > 0) {
      const fees = 2 * feeRate * 2;  // 2 legs, buy + sell each
      this.profitAfterFees = this.arbitrageProfit - fees;
      this.qualifies = this.profitAfterFees > 0;
    } else {
      this.profitAfterFees = 0;
      this.qualifies = false;
    }

    return this;
  }
}

/**
 * Dependency Graph for market relationships
 */
class DependencyGraph {
  constructor(config = {}) {
    this.nodes = new Map();  // marketId -> MarketNode
    this.edges = [];         // DependencyEdge[]
    this.config = {
      minSimilarity: 0.4,    // Minimum subject similarity
      feeRate: 0.02,
      ...config
    };
  }

  /**
   * Add a market to the graph
   */
  addMarket(market) {
    const node = new MarketNode(market);
    this.nodes.set(node.id, node);
    return node;
  }

  /**
   * Add multiple markets
   */
  addMarkets(markets) {
    return markets.map(m => this.addMarket(m));
  }

  /**
   * Build edges by detecting dependencies
   */
  buildEdges() {
    const nodeList = Array.from(this.nodes.values());

    for (let i = 0; i < nodeList.length; i++) {
      for (let j = i + 1; j < nodeList.length; j++) {
        const nodeA = nodeList[i];
        const nodeB = nodeList[j];

        // Check for temporal dependency
        const temporalEdge = this.detectTemporalDependency(nodeA, nodeB);
        if (temporalEdge) {
          this.edges.push(temporalEdge);
          continue;
        }

        // Check for threshold dependency
        const thresholdEdge = this.detectThresholdDependency(nodeA, nodeB);
        if (thresholdEdge) {
          this.edges.push(thresholdEdge);
        }
      }
    }

    return this.edges;
  }

  /**
   * Detect temporal dependency between two markets
   */
  detectTemporalDependency(nodeA, nodeB) {
    // Both need deadlines
    if (!nodeA.deadline || !nodeB.deadline) return null;

    // Subjects need to be similar
    const similarity = this.subjectSimilarity(nodeA.subject, nodeB.subject);
    if (similarity < this.config.minSimilarity) return null;

    // Compare deadlines
    const tsA = nodeA.getDeadlineTimestamp();
    const tsB = nodeB.getDeadlineTimestamp();

    if (tsA === tsB) return null;  // Same deadline, no dependency

    // Earlier deadline implies later deadline
    // "X by March" = true → "X by June" = true
    const [earlier, later] = tsA < tsB ? [nodeA, nodeB] : [nodeB, nodeA];

    return new DependencyEdge(earlier, later, EdgeType.TEMPORAL, Relation.IMPLIES);
  }

  /**
   * Detect threshold dependency between two markets
   */
  detectThresholdDependency(nodeA, nodeB) {
    // Both need thresholds
    if (!nodeA.threshold || !nodeB.threshold) return null;

    // Subjects need to be similar
    const similarity = this.subjectSimilarity(nodeA.subject, nodeB.subject);
    if (similarity < this.config.minSimilarity) return null;

    // Same direction needed
    if (nodeA.threshold.direction !== nodeB.threshold.direction) return null;

    const valA = nodeA.threshold.value;
    const valB = nodeB.threshold.value;

    if (valA === valB) return null;  // Same threshold

    if (nodeA.threshold.direction === 'above') {
      // "X > $150k" = true → "X > $100k" = true
      // Higher threshold implies lower threshold
      const [higher, lower] = valA > valB ? [nodeA, nodeB] : [nodeB, nodeA];
      return new DependencyEdge(higher, lower, EdgeType.THRESHOLD, Relation.IMPLIES);
    } else {
      // "X < $50k" = true → "X < $100k" = true
      // Lower threshold implies higher threshold
      const [lower, higher] = valA < valB ? [nodeA, nodeB] : [nodeB, nodeA];
      return new DependencyEdge(lower, higher, EdgeType.THRESHOLD, Relation.IMPLIES);
    }
  }

  /**
   * Calculate subject similarity (Jaccard index)
   */
  subjectSimilarity(subjectA, subjectB) {
    const wordsA = new Set(subjectA.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(subjectB.toLowerCase().split(/\s+/).filter(w => w.length > 2));

    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);

    return intersection.size / union.size;
  }

  /**
   * Find all constraint violations (arbitrage opportunities)
   */
  findViolations() {
    const violations = [];

    for (const edge of this.edges) {
      edge.evaluate(this.config.feeRate);
      if (edge.violation) {
        violations.push(edge);
      }
    }

    // Sort by profit
    violations.sort((a, b) => b.profitAfterFees - a.profitAfterFees);

    return violations;
  }

  /**
   * Get qualifying opportunities (profitable after fees)
   */
  getOpportunities() {
    return this.findViolations().filter(e => e.qualifies);
  }

  /**
   * Get summary statistics
   */
  getStats() {
    const violations = this.findViolations();
    const opportunities = violations.filter(e => e.qualifies);

    return {
      totalMarkets: this.nodes.size,
      totalEdges: this.edges.length,
      temporalEdges: this.edges.filter(e => e.type === EdgeType.TEMPORAL).length,
      thresholdEdges: this.edges.filter(e => e.type === EdgeType.THRESHOLD).length,
      violations: violations.length,
      opportunities: opportunities.length,
      totalProfit: opportunities.reduce((sum, e) => sum + e.profitAfterFees, 0)
    };
  }

  /**
   * Export to JSON-serializable format
   */
  toJSON() {
    return {
      nodes: Array.from(this.nodes.values()).map(n => ({
        id: n.id,
        question: n.question,
        price: n.price,
        subject: n.subject,
        deadline: n.deadline,
        threshold: n.threshold
      })),
      edges: this.edges.map(e => ({
        fromId: e.from.id,
        toId: e.to.id,
        type: e.type,
        relation: e.relation,
        expectedConstraint: e.expectedConstraint,
        violation: e.violation,
        arbitrageProfit: e.arbitrageProfit,
        profitAfterFees: e.profitAfterFees,
        qualifies: e.qualifies,
        strategy: e.strategy
      })),
      stats: this.getStats()
    };
  }
}

/**
 * Quick analysis function
 */
function analyzeCrossMarketDependencies(markets, config = {}) {
  const graph = new DependencyGraph(config);
  graph.addMarkets(markets);
  graph.buildEdges();
  return graph.toJSON();
}

export {
  DependencyGraph,
  MarketNode,
  DependencyEdge,
  analyzeCrossMarketDependencies,
  EdgeType,
  Relation
};
