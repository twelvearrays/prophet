// ============================================================================
// CORE TYPES FOR POLYMARKET 15-MIN STRATEGY
// ============================================================================

/**
 * Side of the market (YES = price goes up, NO = price goes down)
 */
export type Side = 'YES' | 'NO';

/**
 * Current state of a trading session
 */
export type SessionState =
  | 'WAITING'      // Watching for entry signal
  | 'ENTERED'      // Have a position, watching for scale or hedge
  | 'HEDGED'       // Position has been hedged, locked loss
  | 'RESOLVED';    // Market has resolved

/**
 * Strategy configuration parameters
 */
export interface StrategyConfig {
  // Position sizing
  positionSize: number;           // Total $ to deploy per market (e.g., $30)

  // Entry thresholds
  entryThreshold: number;         // Enter when price >= this (e.g., 0.65 = 65¢)
  scale2Threshold: number;        // Scale in at this price (e.g., 0.73)
  scale3Threshold: number;        // Final scale at this price (e.g., 0.80)

  // Entry allocation percentages (must sum to 1.0)
  entry1Pct: number;              // % on first entry (e.g., 0.50)
  entry2Pct: number;              // % on scale 2 (e.g., 0.30)
  entry3Pct: number;              // % on scale 3 (e.g., 0.20)

  // Hedge parameters
  hedgeDropPoints: number;        // Hedge if price drops this much (e.g., 0.12 = 12 points)

  // Re-entry settings
  allowReentry: boolean;          // Allow re-entry after hedge?
  reentryThresholdIncrease: number; // Increase threshold by this after hedge
  maxHedges: number;              // Maximum number of hedges per market

  // Late game adjustments
  lateGameMinutes: number;        // Minutes before close considered "late game"
  lateGameMinPrice: number;       // Minimum price to enter in late game
}

/**
 * Default strategy configuration
 */
export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  positionSize: 30,
  entryThreshold: 0.65,
  scale2Threshold: 0.73,
  scale3Threshold: 0.80,
  entry1Pct: 0.50,
  entry2Pct: 0.30,
  entry3Pct: 0.20,
  hedgeDropPoints: 0.12,
  allowReentry: false,
  reentryThresholdIncrease: 0.04,
  maxHedges: 3,
  lateGameMinutes: 3,
  lateGameMinPrice: 0.85,
};

/**
 * A single fill/execution in the market
 */
export interface Fill {
  id: string;
  timestamp: number;
  side: Side;
  shares: number;
  price: number;
  cost: number;              // shares * price
  type: 'ENTRY' | 'SCALE' | 'HEDGE';
}

/**
 * Current position state
 */
export interface Position {
  side: Side;
  shares: number;
  avgPrice: number;
  totalCost: number;
  fills: Fill[];
}

/**
 * Represents a hedged pair (guaranteed $1 payout)
 */
export interface HedgedPair {
  yesShares: number;
  noShares: number;
  totalCost: number;
  lockedLoss: number;        // Cost - guaranteed payout
}

/**
 * Complete state of a trading session
 */
export interface TradingSession {
  id: string;
  marketId: string;
  marketName: string;
  startTime: number;
  endTime: number;           // Expected resolution time

  state: SessionState;

  // Current positions
  yesPosition: Position | null;
  noPosition: Position | null;
  hedgedPairs: HedgedPair[];

  // Tracking
  currentThreshold: number;  // May increase after hedges
  entryCount: number;        // 0, 1, 2, or 3
  hedgeCount: number;
  remainingBudget: number;
  lastEntryPrice: number | null;

  // All fills for audit trail
  allFills: Fill[];

  // Resolution
  resolution: Side | null;   // Which side won
  finalPnL: number | null;
}

/**
 * Price tick from the market
 */
export interface PriceTick {
  timestamp: number;
  yesPrice: number;          // 0.00 - 1.00
  noPrice: number;           // Should be ~(1 - yesPrice)
  yesLiquidity: number;      // Available $ on YES side
  noLiquidity: number;       // Available $ on NO side
}

/**
 * Action the strategy wants to take
 */
export type StrategyAction =
  | { type: 'NONE' }
  | { type: 'ENTER'; side: Side; amount: number; price: number }
  | { type: 'SCALE'; side: Side; amount: number; price: number; scaleLevel: 2 | 3 }
  | { type: 'HEDGE'; side: Side; shares: number; price: number }
  | { type: 'CLOSE'; reason: string };

/**
 * Result of evaluating strategy on a tick
 */
export interface StrategyEvaluation {
  action: StrategyAction;
  reason: string;
  currentState: SessionState;
  metrics: {
    priceFromEntry: number | null;    // How far from entry price
    timeRemaining: number;            // Minutes until resolution
    unrealizedPnL: number;            // Current P&L if resolved now
  };
}

/**
 * Summary statistics for a completed session
 */
export interface SessionSummary {
  sessionId: string;
  marketId: string;
  duration: number;          // Actual trading duration in ms

  // Outcomes
  resolution: Side;
  didTrade: boolean;
  won: boolean;

  // P&L
  totalCost: number;
  totalPayout: number;
  pnl: number;
  pnlPercent: number;

  // Activity
  entryCount: number;
  hedgeCount: number;
  wasHedged: boolean;

  // Entry details
  entrySide: Side | null;
  entryPrice: number | null;
}

/**
 * Event emitted by the strategy engine
 */
export type StrategyEvent =
  | { type: 'SESSION_START'; session: TradingSession }
  | { type: 'PRICE_UPDATE'; tick: PriceTick; session: TradingSession }
  | { type: 'ACTION_TAKEN'; action: StrategyAction; fill: Fill; session: TradingSession }
  | { type: 'HEDGE_TRIGGERED'; hedgedPair: HedgedPair; session: TradingSession }
  | { type: 'SESSION_RESOLVED'; summary: SessionSummary }
  | { type: 'ERROR'; error: Error; session: TradingSession };
