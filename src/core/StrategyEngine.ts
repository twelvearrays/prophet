import {
  Side,
  SessionState,
  StrategyConfig,
  DEFAULT_STRATEGY_CONFIG,
  Fill,
  Position,
  HedgedPair,
  TradingSession,
  PriceTick,
  StrategyAction,
  StrategyEvaluation,
  SessionSummary,
  StrategyEvent,
} from '../types';
import { generateId } from '../utils/helpers';

// ============================================================================
// STRATEGY ENGINE
// ============================================================================
// Core logic for the 15-minute crypto prediction market strategy.
// This is a pure logic module - no API calls, no side effects.
// ============================================================================

export class StrategyEngine {
  private config: StrategyConfig;
  private session: TradingSession | null = null;
  private eventHandlers: ((event: StrategyEvent) => void)[] = [];

  constructor(config: Partial<StrategyConfig> = {}) {
    this.config = { ...DEFAULT_STRATEGY_CONFIG, ...config };
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Start a new trading session for a market
   */
  startSession(marketId: string, marketName: string, endTime: number): TradingSession {
    this.session = {
      id: generateId(),
      marketId,
      marketName,
      startTime: Date.now(),
      endTime,
      state: 'WAITING',
      yesPosition: null,
      noPosition: null,
      hedgedPairs: [],
      currentThreshold: this.config.entryThreshold,
      entryCount: 0,
      hedgeCount: 0,
      remainingBudget: this.config.positionSize,
      lastEntryPrice: null,
      allFills: [],
      resolution: null,
      finalPnL: null,
    };

    this.emit({ type: 'SESSION_START', session: this.session });
    return this.session;
  }

  /**
   * Process a new price tick and determine action
   */
  onPriceTick(tick: PriceTick): StrategyEvaluation {
    if (!this.session) {
      throw new Error('No active session. Call startSession() first.');
    }

    this.emit({ type: 'PRICE_UPDATE', tick, session: this.session });

    const timeRemaining = (this.session.endTime - tick.timestamp) / 60000; // minutes
    const evaluation = this.evaluate(tick, timeRemaining);

    return evaluation;
  }

  /**
   * Execute an action (call this after confirming order was filled)
   */
  executeAction(action: StrategyAction, actualPrice: number): Fill | null {
    if (!this.session) {
      throw new Error('No active session');
    }

    if (action.type === 'NONE' || action.type === 'CLOSE') {
      return null;
    }

    const fill = this.recordFill(action, actualPrice);
    this.emit({ type: 'ACTION_TAKEN', action, fill, session: this.session });

    return fill;
  }

  /**
   * Mark the session as resolved
   */
  resolve(winningSide: Side): SessionSummary {
    if (!this.session) {
      throw new Error('No active session');
    }

    this.session.state = 'RESOLVED';
    this.session.resolution = winningSide;

    const summary = this.calculateSummary(winningSide);
    this.session.finalPnL = summary.pnl;

    this.emit({ type: 'SESSION_RESOLVED', summary });

    return summary;
  }

  /**
   * Get current session state
   */
  getSession(): TradingSession | null {
    return this.session;
  }

  /**
   * Subscribe to strategy events
   */
  onEvent(handler: (event: StrategyEvent) => void): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<StrategyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ==========================================================================
  // CORE STRATEGY LOGIC
  // ==========================================================================

  private evaluate(tick: PriceTick, timeRemaining: number): StrategyEvaluation {
    const session = this.session!;

    // Calculate metrics
    const metrics = {
      priceFromEntry: session.lastEntryPrice
        ? this.getCurrentPrice(tick, session.yesPosition?.side || session.noPosition?.side || 'YES') - session.lastEntryPrice
        : null,
      timeRemaining,
      unrealizedPnL: this.calculateUnrealizedPnL(tick),
    };

    // Late game threshold adjustment
    let effectiveThreshold = session.currentThreshold;
    if (timeRemaining < this.config.lateGameMinutes && session.state === 'WAITING') {
      effectiveThreshold = Math.max(effectiveThreshold, this.config.lateGameMinPrice);
    }

    // Check for hedge trigger first (most urgent)
    if (session.state === 'ENTERED') {
      const hedgeAction = this.checkHedgeTrigger(tick);
      if (hedgeAction) {
        return {
          action: hedgeAction,
          reason: `Price dropped ${(this.config.hedgeDropPoints * 100).toFixed(0)} points from entry`,
          currentState: session.state,
          metrics,
        };
      }
    }

    // Check for scale-in opportunity
    if (session.state === 'ENTERED' && session.entryCount < 3) {
      const scaleAction = this.checkScaleIn(tick);
      if (scaleAction) {
        return {
          action: scaleAction,
          reason: `Price reached scale ${session.entryCount + 1} threshold`,
          currentState: session.state,
          metrics,
        };
      }
    }

    // Check for entry opportunity
    if (session.state === 'WAITING' && session.remainingBudget > 5) {
      const entryAction = this.checkEntry(tick, effectiveThreshold);
      if (entryAction) {
        return {
          action: entryAction,
          reason: `Price crossed entry threshold (${(effectiveThreshold * 100).toFixed(0)}¢)`,
          currentState: session.state,
          metrics,
        };
      }
    }

    // No action
    return {
      action: { type: 'NONE' },
      reason: session.state === 'WAITING'
        ? `Waiting for entry (need ${(effectiveThreshold * 100).toFixed(0)}¢, current ${(tick.yesPrice * 100).toFixed(0)}¢/${(tick.noPrice * 100).toFixed(0)}¢)`
        : 'Holding position',
      currentState: session.state,
      metrics,
    };
  }

  private checkEntry(tick: PriceTick, threshold: number): StrategyAction | null {
    const session = this.session!;

    // Check YES entry
    if (tick.yesPrice >= threshold) {
      const entryBudget = session.remainingBudget * this.config.entry1Pct;

      // Check liquidity on hedge side
      if (tick.noLiquidity < entryBudget * 3) {
        return null; // Not enough liquidity to hedge if needed
      }

      return {
        type: 'ENTER',
        side: 'YES',
        amount: entryBudget,
        price: tick.yesPrice,
      };
    }

    // Check NO entry (mirror logic)
    if (tick.noPrice >= threshold) {
      const entryBudget = session.remainingBudget * this.config.entry1Pct;

      // Check liquidity on hedge side
      if (tick.yesLiquidity < entryBudget * 3) {
        return null;
      }

      return {
        type: 'ENTER',
        side: 'NO',
        amount: entryBudget,
        price: tick.noPrice,
      };
    }

    return null;
  }

  private checkScaleIn(tick: PriceTick): StrategyAction | null {
    const session = this.session!;
    const position = session.yesPosition || session.noPosition;

    if (!position || session.remainingBudget < 3) {
      return null;
    }

    const currentPrice = position.side === 'YES' ? tick.yesPrice : tick.noPrice;

    // Check scale 2
    if (session.entryCount === 1 && currentPrice >= this.config.scale2Threshold) {
      const scaleBudget = Math.min(
        session.remainingBudget * 0.5,
        this.config.positionSize * this.config.entry2Pct
      );

      return {
        type: 'SCALE',
        side: position.side,
        amount: scaleBudget,
        price: currentPrice,
        scaleLevel: 2,
      };
    }

    // Check scale 3
    if (session.entryCount === 2 && currentPrice >= this.config.scale3Threshold) {
      const scaleBudget = Math.min(
        session.remainingBudget * 0.5,
        this.config.positionSize * this.config.entry3Pct
      );

      return {
        type: 'SCALE',
        side: position.side,
        amount: scaleBudget,
        price: currentPrice,
        scaleLevel: 3,
      };
    }

    return null;
  }

  private checkHedgeTrigger(tick: PriceTick): StrategyAction | null {
    const session = this.session!;
    const position = session.yesPosition || session.noPosition;

    if (!position || session.lastEntryPrice === null) {
      return null;
    }

    const currentPrice = position.side === 'YES' ? tick.yesPrice : tick.noPrice;
    const dropFromEntry = session.lastEntryPrice - currentPrice;

    if (dropFromEntry >= this.config.hedgeDropPoints) {
      // Need to hedge - buy opposite side
      const hedgeSide: Side = position.side === 'YES' ? 'NO' : 'YES';
      const hedgePrice = position.side === 'YES' ? tick.noPrice : tick.yesPrice;
      const hedgeLiquidity = position.side === 'YES' ? tick.noLiquidity : tick.yesLiquidity;

      // Check liquidity
      const hedgeCost = position.shares * hedgePrice;
      if (hedgeLiquidity < hedgeCost) {
        // Emit warning but don't block - this is bad
        this.emit({
          type: 'ERROR',
          error: new Error(`HEDGE LIQUIDITY FAILURE: Need $${hedgeCost.toFixed(2)}, only $${hedgeLiquidity.toFixed(2)} available`),
          session,
        });
        return null;
      }

      return {
        type: 'HEDGE',
        side: hedgeSide,
        shares: position.shares,
        price: hedgePrice,
      };
    }

    return null;
  }

  // ==========================================================================
  // POSITION MANAGEMENT
  // ==========================================================================

  private recordFill(action: StrategyAction, actualPrice: number): Fill {
    const session = this.session!;

    if (action.type === 'NONE' || action.type === 'CLOSE') {
      throw new Error('Cannot record fill for NONE/CLOSE action');
    }

    const fill: Fill = {
      id: generateId(),
      timestamp: Date.now(),
      side: action.side,
      shares: action.type === 'HEDGE' ? action.shares : action.amount / actualPrice,
      price: actualPrice,
      cost: action.type === 'HEDGE' ? action.shares * actualPrice : action.amount,
      type: action.type === 'ENTER' ? 'ENTRY' : action.type === 'SCALE' ? 'SCALE' : 'HEDGE',
    };

    session.allFills.push(fill);

    // Update position
    if (action.type === 'ENTER' || action.type === 'SCALE') {
      this.updatePosition(fill);
      session.lastEntryPrice = actualPrice;
      session.entryCount++;
      session.remainingBudget -= fill.cost;
      session.state = 'ENTERED';
    } else if (action.type === 'HEDGE') {
      this.recordHedge(fill);
    }

    return fill;
  }

  private updatePosition(fill: Fill): void {
    const session = this.session!;
    const positionKey = fill.side === 'YES' ? 'yesPosition' : 'noPosition';

    if (!session[positionKey]) {
      session[positionKey] = {
        side: fill.side,
        shares: 0,
        avgPrice: 0,
        totalCost: 0,
        fills: [],
      };
    }

    const position = session[positionKey]!;
    const newTotalCost = position.totalCost + fill.cost;
    const newShares = position.shares + fill.shares;

    position.shares = newShares;
    position.totalCost = newTotalCost;
    position.avgPrice = newTotalCost / newShares;
    position.fills.push(fill);
  }

  private recordHedge(fill: Fill): void {
    const session = this.session!;
    const originalPosition = fill.side === 'YES' ? session.noPosition : session.yesPosition;

    if (!originalPosition) {
      throw new Error('Cannot hedge without original position');
    }

    // Create hedged pair
    const hedgedPair: HedgedPair = {
      yesShares: fill.side === 'YES' ? fill.shares : originalPosition.shares,
      noShares: fill.side === 'NO' ? fill.shares : originalPosition.shares,
      totalCost: originalPosition.totalCost + fill.cost,
      lockedLoss: originalPosition.totalCost + fill.cost - Math.min(fill.shares, originalPosition.shares),
    };

    session.hedgedPairs.push(hedgedPair);
    session.hedgeCount++;

    // Update hedge-side position
    this.updatePosition(fill);

    // Handle re-entry or done
    if (this.config.allowReentry && session.hedgeCount < this.config.maxHedges && session.remainingBudget > 5) {
      session.currentThreshold += this.config.reentryThresholdIncrease;
      session.state = 'WAITING';
      session.entryCount = 0;
      session.lastEntryPrice = null;
    } else {
      session.state = 'HEDGED';
      session.remainingBudget = 0;
    }

    this.emit({ type: 'HEDGE_TRIGGERED', hedgedPair, session });
  }

  // ==========================================================================
  // P&L CALCULATION
  // ==========================================================================

  private calculateUnrealizedPnL(tick: PriceTick): number {
    const session = this.session!;

    // Hedged pairs always pay $1 each
    let payout = session.hedgedPairs.reduce((sum, pair) => sum + Math.min(pair.yesShares, pair.noShares), 0);

    // Unhedged positions - estimate based on current price
    const yesShares = session.yesPosition?.shares || 0;
    const noShares = session.noPosition?.shares || 0;
    const hedgedShares = session.hedgedPairs.reduce((sum, pair) => sum + Math.min(pair.yesShares, pair.noShares), 0);

    const unhedgedYes = Math.max(0, yesShares - hedgedShares);
    const unhedgedNo = Math.max(0, noShares - hedgedShares);

    // Use current price as probability of winning
    payout += unhedgedYes * tick.yesPrice;
    payout += unhedgedNo * tick.noPrice;

    const totalCost = session.allFills.reduce((sum, fill) => sum + fill.cost, 0);
    return payout - totalCost;
  }

  private calculateSummary(winningSide: Side): SessionSummary {
    const session = this.session!;

    // Calculate total cost
    const totalCost = session.allFills.reduce((sum, fill) => sum + fill.cost, 0);

    // Calculate payout
    let totalPayout = 0;

    // Hedged pairs pay $1 per pair
    const hedgedShares = session.hedgedPairs.reduce(
      (sum, pair) => sum + Math.min(pair.yesShares, pair.noShares),
      0
    );
    totalPayout += hedgedShares;

    // Unhedged shares pay $1 if they win
    const yesShares = session.yesPosition?.shares || 0;
    const noShares = session.noPosition?.shares || 0;
    const unhedgedYes = Math.max(0, yesShares - hedgedShares);
    const unhedgedNo = Math.max(0, noShares - hedgedShares);

    if (winningSide === 'YES' && unhedgedYes > 0) {
      totalPayout += unhedgedYes;
    } else if (winningSide === 'NO' && unhedgedNo > 0) {
      totalPayout += unhedgedNo;
    }

    const pnl = totalPayout - totalCost;
    const didTrade = session.allFills.length > 0;

    // Determine if we won
    const entrySide = session.allFills.find(f => f.type === 'ENTRY')?.side || null;
    const won = didTrade && pnl > 0;

    return {
      sessionId: session.id,
      marketId: session.marketId,
      duration: Date.now() - session.startTime,
      resolution: winningSide,
      didTrade,
      won,
      totalCost,
      totalPayout,
      pnl,
      pnlPercent: totalCost > 0 ? (pnl / totalCost) * 100 : 0,
      entryCount: session.entryCount,
      hedgeCount: session.hedgeCount,
      wasHedged: session.hedgeCount > 0,
      entrySide,
      entryPrice: session.allFills.find(f => f.type === 'ENTRY')?.price || null,
    };
  }

  private getCurrentPrice(tick: PriceTick, side: Side): number {
    return side === 'YES' ? tick.yesPrice : tick.noPrice;
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  private emit(event: StrategyEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (e) {
        console.error('Event handler error:', e);
      }
    }
  }
}
