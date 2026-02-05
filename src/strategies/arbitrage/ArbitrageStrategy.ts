/**
 * ArbitrageStrategy - Frank-Wolfe Combinatorial Arbitrage Detection
 *
 * Integrates with existing PolymarketClient to detect and exploit
 * cross-market arbitrage opportunities using the Frank-Wolfe algorithm.
 *
 * Based on:
 * - Kroer et al. 2016 (arXiv:1606.02825)
 * - Saguillo et al. 2025 (arXiv:2508.03474)
 */

import { PolymarketClient, CryptoMarket } from '../../api/PolymarketClient';
import { PriceTick } from '../../types';
import {
  ArbitrageConfig,
  ArbitrageOpportunity,
  ArbitrageTrade,
  ConstraintGraph,
  DEFAULT_ARBITRAGE_CONFIG,
  createConstraintGraph,
  createPartialOutcome,
} from './types';
import { createSolver, SolverBackend } from './solver';
import {
  InitFW,
  BarrierFrankWolfe,
  ProfitCalculator,
  pricesToTheta,
  thetaToPrices,
  computeMispricing,
} from './algorithms';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Market group for arbitrage analysis
 */
export interface MarketGroup {
  /** Unique identifier for this group */
  id: string;

  /** Markets in this group */
  markets: CryptoMarket[];

  /** Constraint graph defining relationships */
  constraintGraph: ConstraintGraph;

  /** Last known prices for each security */
  prices: Map<string, number>;

  /** Token ID to security index mapping */
  tokenToIndex: Map<string, number>;

  /** Security index to token ID mapping */
  indexToToken: Map<number, string>;
}

/**
 * Arbitrage strategy event
 */
export type ArbitrageEvent =
  | { type: 'OPPORTUNITY_DETECTED'; opportunity: ArbitrageOpportunity }
  | { type: 'OPPORTUNITY_EXECUTED'; opportunity: ArbitrageOpportunity; results: any }
  | { type: 'ANALYSIS_COMPLETE'; marketGroup: string; mispricing: number }
  | { type: 'ERROR'; error: Error; context: string };

// ============================================================================
// ARBITRAGE STRATEGY
// ============================================================================

/**
 * ArbitrageStrategy detects and signals arbitrage opportunities
 * across correlated Polymarket markets using the Frank-Wolfe algorithm.
 *
 * Usage:
 *   const client = new PolymarketClient();
 *   const strategy = new ArbitrageStrategy(client);
 *
 *   strategy.onEvent((event) => {
 *     if (event.type === 'OPPORTUNITY_DETECTED') {
 *       console.log('Arbitrage found!', event.opportunity);
 *     }
 *   });
 *
 *   // Add markets to monitor
 *   const btcMarket = await client.getCryptoMarkets(['BTC']);
 *   strategy.addBinaryMarket(btcMarket[0]);
 *
 *   // Start monitoring
 *   await strategy.start();
 */
export class ArbitrageStrategy {
  private client: PolymarketClient;
  private config: ArbitrageConfig;
  private solver: SolverBackend;
  private initFW: InitFW;
  private barrierFW: BarrierFrankWolfe;
  private profitCalc: ProfitCalculator;

  private marketGroups: Map<string, MarketGroup> = new Map();
  private eventHandlers: ((event: ArbitrageEvent) => void)[] = [];
  private running: boolean = false;
  private analysisInterval: NodeJS.Timeout | null = null;

  constructor(client: PolymarketClient, config?: Partial<ArbitrageConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_ARBITRAGE_CONFIG, ...config };
    this.solver = createSolver(this.config.solverTimeout);
    this.initFW = new InitFW(this.solver);
    this.barrierFW = new BarrierFrankWolfe(this.solver, this.config);
    this.profitCalc = new ProfitCalculator(this.config);
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Subscribe to strategy events
   */
  onEvent(handler: (event: ArbitrageEvent) => void): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * Add a binary market for monitoring
   */
  addBinaryMarket(market: CryptoMarket): void {
    const groupId = `binary_${market.conditionId}`;

    // Create constraint graph for binary market (YES + NO = 1)
    const constraintGraph = createConstraintGraph(2);
    constraintGraph.addExactlyOneConstraint([0, 1]);

    const tokenToIndex = new Map<string, number>([
      [market.yesTokenId, 0],
      [market.noTokenId, 1],
    ]);

    const indexToToken = new Map<number, string>([
      [0, market.yesTokenId],
      [1, market.noTokenId],
    ]);

    const group: MarketGroup = {
      id: groupId,
      markets: [market],
      constraintGraph,
      prices: new Map(),
      tokenToIndex,
      indexToToken,
    };

    this.marketGroups.set(groupId, group);
    console.log(`[Arbitrage] Added binary market: ${market.question.slice(0, 50)}`);
  }

  /**
   * Add correlated markets (e.g., nested election outcomes)
   * Example: "Trump wins PA" and "GOP +5 electoral votes"
   */
  addCorrelatedMarkets(
    markets: CryptoMarket[],
    implications: Array<{ from: string; to: string }>
  ): void {
    const groupId = `correlated_${markets.map((m) => m.conditionId).join('_').slice(0, 50)}`;
    const dimension = markets.length * 2; // Each market has YES/NO

    const constraintGraph = createConstraintGraph(dimension);
    const tokenToIndex = new Map<string, number>();
    const indexToToken = new Map<number, string>();

    // Add each market's binary constraint
    for (let i = 0; i < markets.length; i++) {
      const market = markets[i];
      const yesIdx = i * 2;
      const noIdx = i * 2 + 1;

      tokenToIndex.set(market.yesTokenId, yesIdx);
      tokenToIndex.set(market.noTokenId, noIdx);
      indexToToken.set(yesIdx, market.yesTokenId);
      indexToToken.set(noIdx, market.noTokenId);

      // YES + NO = 1 for each market
      constraintGraph.addExactlyOneConstraint([yesIdx, noIdx]);
    }

    // Add implication constraints
    for (const impl of implications) {
      const fromIdx = tokenToIndex.get(impl.from);
      const toIdx = tokenToIndex.get(impl.to);
      if (fromIdx !== undefined && toIdx !== undefined) {
        constraintGraph.addImplicationConstraint(fromIdx, toIdx);
      }
    }

    const group: MarketGroup = {
      id: groupId,
      markets,
      constraintGraph,
      prices: new Map(),
      tokenToIndex,
      indexToToken,
    };

    this.marketGroups.set(groupId, group);
    console.log(`[Arbitrage] Added correlated markets group: ${groupId}`);
  }

  /**
   * Update price for a token
   */
  updatePrice(tokenId: string, price: number): void {
    for (const group of this.marketGroups.values()) {
      if (group.tokenToIndex.has(tokenId)) {
        group.prices.set(tokenId, price);
      }
    }
  }

  /**
   * Process a price tick and check for arbitrage
   */
  processPriceTick(tick: PriceTick, market: CryptoMarket): ArbitrageOpportunity | null {
    // Find the market group
    for (const group of this.marketGroups.values()) {
      if (group.markets.some((m) => m.conditionId === market.conditionId)) {
        // Update prices
        group.prices.set(market.yesTokenId, tick.yesPrice);
        group.prices.set(market.noTokenId, tick.noPrice);

        // Run analysis
        return this.analyzeGroup(group);
      }
    }
    return null;
  }

  /**
   * Start continuous monitoring
   */
  async start(analysisIntervalMs: number = 5000): Promise<void> {
    this.running = true;

    // Connect WebSocket
    await this.client.connectWebSocket();

    // Subscribe to all markets
    for (const group of this.marketGroups.values()) {
      for (const market of group.markets) {
        this.client.subscribeToMarket(market, (tick) => {
          const opportunity = this.processPriceTick(tick, market);
          if (opportunity && opportunity.shouldTrade) {
            this.emit({ type: 'OPPORTUNITY_DETECTED', opportunity });
          }
        });
      }
    }

    // Periodic analysis
    this.analysisInterval = setInterval(() => {
      this.analyzeAll();
    }, analysisIntervalMs);

    console.log('[Arbitrage] Strategy started');
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    this.running = false;
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }
    this.client.disconnect();
    console.log('[Arbitrage] Strategy stopped');
  }

  /**
   * Analyze all market groups for arbitrage
   */
  analyzeAll(): void {
    for (const group of this.marketGroups.values()) {
      try {
        const opportunity = this.analyzeGroup(group);
        if (opportunity && opportunity.shouldTrade) {
          this.emit({ type: 'OPPORTUNITY_DETECTED', opportunity });
        }
      } catch (error) {
        this.emit({
          type: 'ERROR',
          error: error as Error,
          context: `Analyzing group ${group.id}`,
        });
      }
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): ArbitrageConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ArbitrageConfig>): void {
    this.config = { ...this.config, ...config };
    this.barrierFW = new BarrierFrankWolfe(this.solver, this.config);
    this.profitCalc = new ProfitCalculator(this.config);
  }

  // ==========================================================================
  // CORE ANALYSIS
  // ==========================================================================

  /**
   * Analyze a market group for arbitrage opportunities
   */
  private analyzeGroup(group: MarketGroup): ArbitrageOpportunity | null {
    const dimension = group.constraintGraph.dimension;

    // Build price vector
    const prices: number[] = new Array(dimension).fill(0.5);
    for (let i = 0; i < dimension; i++) {
      const tokenId = group.indexToToken.get(i);
      if (tokenId) {
        const price = group.prices.get(tokenId);
        if (price !== undefined) {
          prices[i] = price;
        }
      }
    }

    // Check for obvious mispricing
    const mispricing = computeMispricing(prices);
    this.emit({
      type: 'ANALYSIS_COMPLETE',
      marketGroup: group.id,
      mispricing,
    });

    // If near arbitrage-free, skip detailed analysis
    if (mispricing < this.config.minDivergence) {
      return null;
    }

    // Convert prices to LMSR theta
    const theta = pricesToTheta(prices, this.config.liquidityParam);

    // Initialize Frank-Wolfe
    const initResult = this.initFW.initialize(
      dimension,
      group.constraintGraph,
      createPartialOutcome()
    );

    if (initResult.numVertices === 0) {
      console.warn(`[Arbitrage] No vertices found for group ${group.id}`);
      return null;
    }

    // Run Barrier Frank-Wolfe
    const bfwResult = this.barrierFW.optimize(
      theta,
      initResult,
      group.constraintGraph,
      this.config.liquidityParam
    );

    // Make trade decision
    const decision = this.profitCalc.shouldTrade(
      bfwResult.finalDivergence,
      bfwResult.finalGap,
      this.config.executionCost
    );

    // Build opportunity result
    const trades = this.computeTrades(group, prices, bfwResult.muOptimal);

    return {
      marketIds: group.markets.map((m) => m.conditionId),
      muOptimal: bfwResult.muOptimal,
      divergence: bfwResult.finalDivergence,
      gap: bfwResult.finalGap,
      guaranteedProfit: this.profitCalc.computeGuaranteedProfit(
        bfwResult.finalDivergence,
        bfwResult.finalGap
      ),
      trades,
      shouldTrade: decision.shouldTrade,
      reason: decision.reason,
    };
  }

  /**
   * Compute recommended trades from optimal mu
   */
  private computeTrades(
    group: MarketGroup,
    currentPrices: number[],
    optimalMu: number[]
  ): ArbitrageTrade[] {
    const trades: ArbitrageTrade[] = [];

    for (let i = 0; i < optimalMu.length; i++) {
      const tokenId = group.indexToToken.get(i);
      if (!tokenId) continue;

      const currentPrice = currentPrices[i];
      const optimalWeight = optimalMu[i];
      const priceDiff = optimalWeight - currentPrice;

      // Only trade if significant difference
      if (Math.abs(priceDiff) > 0.01) {
        const market = group.markets.find(
          (m) => m.yesTokenId === tokenId || m.noTokenId === tokenId
        );

        if (market) {
          trades.push({
            marketId: market.conditionId,
            tokenId,
            side: priceDiff > 0 ? 'buy' : 'sell',
            quantity: Math.abs(priceDiff) * 100, // Scale by position size
            price: currentPrice,
          });
        }
      }
    }

    return trades;
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  private emit(event: ArbitrageEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (e) {
        console.error('[Arbitrage] Event handler error:', e);
      }
    }
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a configured ArbitrageStrategy
 */
export function createArbitrageStrategy(
  client: PolymarketClient,
  config?: Partial<ArbitrageConfig>
): ArbitrageStrategy {
  return new ArbitrageStrategy(client, config);
}
