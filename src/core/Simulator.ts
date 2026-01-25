import { PriceTick, Side, SessionSummary } from '../types';
import { StrategyEngine } from './StrategyEngine';

// ============================================================================
// PRICE PATH SIMULATOR
// ============================================================================
// Generates realistic price paths for testing the strategy.
// Uses the same logic as the Monte Carlo simulator.
// ============================================================================

export interface SimulatorConfig {
  startPrice: number;
  volatility: number;
  momentumFactor: number;
  meanReversionFactor: number;
  driftStrength: number;
  stepsPerMinute: number;
  totalMinutes: number;
  baseLiquidity: number;
}

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  startPrice: 0.50,
  volatility: 0.03,
  momentumFactor: 0.55,
  meanReversionFactor: 0.025,
  driftStrength: 0.008,
  stepsPerMinute: 4,
  totalMinutes: 15,
  baseLiquidity: 200,
};

export interface SimulationResult {
  summary: SessionSummary;
  pricePath: PriceTick[];
  resolution: Side;
}

export class Simulator {
  private config: SimulatorConfig;

  constructor(config: Partial<SimulatorConfig> = {}) {
    this.config = { ...DEFAULT_SIMULATOR_CONFIG, ...config };
  }

  /**
   * Generate a single price path
   */
  generatePricePath(): { ticks: PriceTick[]; resolution: Side } {
    const steps = this.config.stepsPerMinute * this.config.totalMinutes;
    const ticks: PriceTick[] = [];

    let price = this.config.startPrice;
    let previousMove = 0;
    const startTime = Date.now();
    const stepDuration = (this.config.totalMinutes * 60000) / steps;

    for (let i = 0; i <= steps; i++) {
      const minute = i / this.config.stepsPerMinute;
      const timeProgress = minute / this.config.totalMinutes;
      const timestamp = startTime + i * stepDuration;

      // Generate price movement
      if (i > 0) {
        const randomShock = (Math.random() - 0.5) * 2 * this.config.volatility;
        const momentumComponent = previousMove * this.config.momentumFactor;
        const meanReversionComponent = (0.50 - price) * this.config.meanReversionFactor;
        const driftDirection = price > 0.5 ? 1 : -1;
        const driftComponent = driftDirection * this.config.driftStrength * timeProgress;
        const lateGameBoost = minute > (this.config.totalMinutes - 3) ? 1.5 : 1.0;

        const move = (randomShock * lateGameBoost) + momentumComponent + meanReversionComponent + driftComponent;
        price = Math.max(0.01, Math.min(0.99, price + move));
        previousMove = move;
      }

      // Generate liquidity (with some randomness)
      const liquidityMultiplier = 1 + (Math.random() - 0.5) * 0.3;
      const extremePenalty = (price > 0.85 || price < 0.15) ? 0.5 : 1.0;
      const liquidity = this.config.baseLiquidity * liquidityMultiplier * extremePenalty;

      ticks.push({
        timestamp,
        yesPrice: price,
        noPrice: 1 - price,
        yesLiquidity: liquidity,
        noLiquidity: liquidity,
      });
    }

    const finalPrice = ticks[ticks.length - 1].yesPrice;
    const resolution: Side = finalPrice > 0.5 ? 'YES' : 'NO';

    return { ticks, resolution };
  }

  /**
   * Run a single simulation
   */
  runOne(engine: StrategyEngine, verbose: boolean = false): SimulationResult {
    const { ticks, resolution } = this.generatePricePath();
    const endTime = ticks[ticks.length - 1].timestamp;

    // Start session
    engine.startSession('sim-market', 'Simulated Market', endTime);

    // Process each tick
    for (const tick of ticks) {
      const evaluation = engine.onPriceTick(tick);

      if (verbose && evaluation.action.type !== 'NONE') {
        console.log(`[${new Date(tick.timestamp).toISOString()}] ${evaluation.reason}`);
        console.log(`  Action: ${JSON.stringify(evaluation.action)}`);
      }

      // Execute action if any
      if (evaluation.action.type !== 'NONE' && evaluation.action.type !== 'CLOSE') {
        const actualPrice = 'price' in evaluation.action ? evaluation.action.price : 0;
        engine.executeAction(evaluation.action, actualPrice);
      }
    }

    // Resolve
    const summary = engine.resolve(resolution);

    return { summary, pricePath: ticks, resolution };
  }

  /**
   * Run multiple simulations and aggregate results
   */
  runMany(
    createEngine: () => StrategyEngine,
    numSimulations: number,
    progressCallback?: (completed: number, total: number) => void
  ): {
    results: SimulationResult[];
    stats: SimulationStats;
  } {
    const results: SimulationResult[] = [];

    for (let i = 0; i < numSimulations; i++) {
      const engine = createEngine();
      const result = this.runOne(engine);
      results.push(result);

      if (progressCallback && i % 100 === 0) {
        progressCallback(i, numSimulations);
      }
    }

    const stats = this.calculateStats(results);
    return { results, stats };
  }

  /**
   * Calculate aggregate statistics
   */
  private calculateStats(results: SimulationResult[]): SimulationStats {
    const tradedResults = results.filter(r => r.summary.didTrade);
    const noTradeResults = results.filter(r => !r.summary.didTrade);

    const wins = tradedResults.filter(r => r.summary.won).length;
    const losses = tradedResults.filter(r => !r.summary.won && r.summary.pnl < 0).length;
    const breakeven = tradedResults.filter(r => Math.abs(r.summary.pnl) < 0.01).length;

    const tradedPnLs = tradedResults.map(r => r.summary.pnl);
    const totalPnL = tradedPnLs.reduce((a, b) => a + b, 0);
    const avgPnL = tradedPnLs.length > 0 ? totalPnL / tradedPnLs.length : 0;

    // Hedged vs unhedged
    const hedgedTrades = tradedResults.filter(r => r.summary.wasHedged);
    const unhedgedTrades = tradedResults.filter(r => !r.summary.wasHedged);

    const hedgedAvgPnL = hedgedTrades.length > 0
      ? hedgedTrades.reduce((sum, r) => sum + r.summary.pnl, 0) / hedgedTrades.length
      : 0;
    const unhedgedAvgPnL = unhedgedTrades.length > 0
      ? unhedgedTrades.reduce((sum, r) => sum + r.summary.pnl, 0) / unhedgedTrades.length
      : 0;

    // Percentiles
    const sortedPnLs = [...tradedPnLs].sort((a, b) => a - b);
    const getPercentile = (p: number) => sortedPnLs.length > 0
      ? sortedPnLs[Math.floor(sortedPnLs.length * p)]
      : 0;

    // Standard deviation
    const variance = tradedPnLs.length > 0
      ? tradedPnLs.reduce((sum, pnl) => sum + Math.pow(pnl - avgPnL, 2), 0) / tradedPnLs.length
      : 0;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? avgPnL / stdDev : 0;

    return {
      totalSimulations: results.length,
      traded: tradedResults.length,
      noTrade: noTradeResults.length,
      entryRate: (tradedResults.length / results.length) * 100,

      wins,
      losses,
      breakeven,
      winRate: tradedResults.length > 0 ? (wins / tradedResults.length) * 100 : 0,

      totalPnL,
      avgPnL,
      medianPnL: getPercentile(0.5),
      stdDev,
      sharpe,

      percentile5: getPercentile(0.05),
      percentile25: getPercentile(0.25),
      percentile75: getPercentile(0.75),
      percentile95: getPercentile(0.95),

      minPnL: sortedPnLs[0] || 0,
      maxPnL: sortedPnLs[sortedPnLs.length - 1] || 0,

      hedgedCount: hedgedTrades.length,
      unhedgedCount: unhedgedTrades.length,
      hedgedAvgPnL,
      unhedgedAvgPnL,
      hedgedWinRate: hedgedTrades.length > 0
        ? (hedgedTrades.filter(r => r.summary.won).length / hedgedTrades.length) * 100
        : 0,
      unhedgedWinRate: unhedgedTrades.length > 0
        ? (unhedgedTrades.filter(r => r.summary.won).length / unhedgedTrades.length) * 100
        : 0,
    };
  }
}

export interface SimulationStats {
  totalSimulations: number;
  traded: number;
  noTrade: number;
  entryRate: number;

  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;

  totalPnL: number;
  avgPnL: number;
  medianPnL: number;
  stdDev: number;
  sharpe: number;

  percentile5: number;
  percentile25: number;
  percentile75: number;
  percentile95: number;

  minPnL: number;
  maxPnL: number;

  hedgedCount: number;
  unhedgedCount: number;
  hedgedAvgPnL: number;
  unhedgedAvgPnL: number;
  hedgedWinRate: number;
  unhedgedWinRate: number;
}
