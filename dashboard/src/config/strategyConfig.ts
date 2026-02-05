/**
 * Centralized Strategy Configuration
 *
 * All strategy parameters in one place, exposed to UI for adjustment
 */

// Momentum Strategy Configuration
export interface MomentumConfig {
  // Position sizing
  positionSize: number           // $ per entry

  // Entry thresholds
  entryThreshold: number         // Enter when price crosses this (e.g., 0.65 = 65¢)
  maxEntryPrice: number          // Don't enter above this (missed entry)

  // Scaling thresholds
  scale2Threshold: number        // Add position at this price
  scale3Threshold: number        // Add more at this price

  // Take profit (NEW!)
  takeProfitEnabled: boolean     // Enable take-profit exits
  takeProfitThreshold: number    // Exit when price hits this (e.g., 0.95 = 95¢)

  // Hedge settings
  baseHedgeTrigger: number       // Floor: hedge when price drops below this
  hedgeTrailingPts: number       // Trailing: hedge when price drops X pts from entry

  // Time-decay hedge thresholds
  hedgeTrigger5minPlus: number   // 5+ min remaining
  hedgeTrigger3to5min: number    // 3-5 min remaining
  hedgeTrigger1to3min: number    // 1-3 min remaining
  hedgeTriggerUnder1min: number  // <1 min remaining

  // Hedge limits
  maxHedges: number              // Max hedges per session
  minTimeForHedgeMinutes: number // Don't hedge with less time
  extremePriceNoHedge: { low: number; high: number }  // Don't hedge at extreme prices

  // Timing
  lateGameMinutes: number
  lateGameThreshold: number

  // Realism/execution
  slippageBps: number            // Slippage in basis points
  confirmationTicks: number      // Ticks before fill
  cooldownAfterFillMs: number    // Cooldown after fills

  // Liquidity
  minLiquidityForEntry: number
  minLiquidityForHedge: number
}

// Dual-Entry Strategy Configuration
export interface DualEntryConfig {
  // Order placement
  makerBidPrice: number          // Aggressive bid (e.g., 0.46 = 46¢)
  makerAskPrice: number          // Conservative bid (e.g., 0.54 = 54¢)
  investmentPerSide: number      // $ per side

  // Exit thresholds (relative to entry)
  loserDropPct: number           // Exit loser at this % drop
  winnerGainPct: number          // Exit winner at this % gain

  // Time settings
  forceExitMinutesLeft: number
  warnMinutesLeft: number
  minTimeToEnterMinutes: number

  // Execution
  slippageBps: number
  makerRebateBps: number

  // Fees
  feeRate: number
  feeExponent: number
}

// Arbitrage Strategy Configuration (Frank-Wolfe Algorithm)
export interface ArbitrageConfig {
  // Alpha-extraction threshold
  alpha: number                     // Fraction of arbitrage to capture (e.g., 0.9 = 90%)
  minDivergence: number             // Minimum Bregman divergence to trade (e.g., 0.025 = 2.5%)

  // Algorithm parameters
  maxIterations: number             // Max Frank-Wolfe iterations
  tolerance: number                 // Convergence tolerance
  solverTimeout: number             // IP solver timeout in seconds

  // Trading parameters
  minProfitAfterCosts: number       // Minimum profit after execution costs
  executionCost: number             // Estimated execution cost as fraction
  liquidityParam: number            // LMSR liquidity parameter (b)
  positionSize: number              // $ per arbitrage trade
}

// System Configuration
export interface SystemConfig {
  autoRestartOnNewMarket: boolean  // Auto-restart sessions when new market window starts
  paperTrading: boolean            // Paper trading vs live
  portfolioValue: number           // Starting portfolio value for tracking
}

// Full configuration object
export interface StrategyConfigState {
  momentum: MomentumConfig
  dualEntry: DualEntryConfig
  arbitrage: ArbitrageConfig
  system: SystemConfig
}

// Default configurations
export const DEFAULT_MOMENTUM_CONFIG: MomentumConfig = {
  positionSize: 30,
  entryThreshold: 0.65,
  maxEntryPrice: 0.75,
  scale2Threshold: 0.73,
  scale3Threshold: 0.80,

  // Take profit - NEW!
  takeProfitEnabled: true,
  takeProfitThreshold: 0.95,

  // Hedge settings
  baseHedgeTrigger: 0.48,
  hedgeTrailingPts: 0.17,
  hedgeTrigger5minPlus: 0.48,
  hedgeTrigger3to5min: 0.50,
  hedgeTrigger1to3min: 0.52,
  hedgeTriggerUnder1min: 0.55,

  maxHedges: 2,
  minTimeForHedgeMinutes: 2,
  extremePriceNoHedge: { low: 0.15, high: 0.85 },

  lateGameMinutes: 3,
  lateGameThreshold: 0.85,

  slippageBps: 100,
  confirmationTicks: 3,
  cooldownAfterFillMs: 10000,

  minLiquidityForEntry: 50,
  minLiquidityForHedge: 100,
}

export const DEFAULT_DUAL_ENTRY_CONFIG: DualEntryConfig = {
  makerBidPrice: 0.46,
  makerAskPrice: 0.54,
  investmentPerSide: 100,

  loserDropPct: 0.15,
  winnerGainPct: 0.20,

  forceExitMinutesLeft: 1,
  warnMinutesLeft: 3,
  minTimeToEnterMinutes: 2,

  slippageBps: 0,
  makerRebateBps: 0,

  feeRate: 0.25,
  feeExponent: 2,
}

export const DEFAULT_ARBITRAGE_CONFIG: ArbitrageConfig = {
  alpha: 0.9,                    // Capture 90% of arbitrage
  minDivergence: 0.025,          // 2.5% minimum mispricing
  maxIterations: 100,            // Max Frank-Wolfe iterations
  tolerance: 1e-6,               // Convergence tolerance
  solverTimeout: 10,             // 10 second solver timeout
  minProfitAfterCosts: 0.01,     // 1% minimum profit after costs
  executionCost: 0.02,           // 2% estimated execution cost
  liquidityParam: 100,           // LMSR b parameter
  positionSize: 50,              // $50 per arbitrage trade
}

export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  autoRestartOnNewMarket: false,
  paperTrading: true,
  portfolioValue: 1000,
}

export const DEFAULT_CONFIG: StrategyConfigState = {
  momentum: DEFAULT_MOMENTUM_CONFIG,
  dualEntry: DEFAULT_DUAL_ENTRY_CONFIG,
  arbitrage: DEFAULT_ARBITRAGE_CONFIG,
  system: DEFAULT_SYSTEM_CONFIG,
}

// Config labels for UI display
export const CONFIG_LABELS: Record<string, { label: string; description: string; unit?: string; min?: number; max?: number; step?: number }> = {
  // Momentum
  'momentum.positionSize': { label: 'Position Size', description: 'Dollar amount per entry', unit: '$', min: 5, max: 500, step: 5 },
  'momentum.entryThreshold': { label: 'Entry Threshold', description: 'Enter when price crosses this', unit: '¢', min: 0.50, max: 0.80, step: 0.01 },
  'momentum.maxEntryPrice': { label: 'Max Entry Price', description: 'Don\'t enter above this', unit: '¢', min: 0.60, max: 0.90, step: 0.01 },
  'momentum.scale2Threshold': { label: 'Scale 2 Threshold', description: 'Add to position at this price', unit: '¢', min: 0.65, max: 0.85, step: 0.01 },
  'momentum.scale3Threshold': { label: 'Scale 3 Threshold', description: 'Add more at this price', unit: '¢', min: 0.70, max: 0.90, step: 0.01 },
  'momentum.takeProfitEnabled': { label: 'Take Profit Enabled', description: 'Auto-exit at profit target' },
  'momentum.takeProfitThreshold': { label: 'Take Profit Price', description: 'Exit when price hits this', unit: '¢', min: 0.85, max: 0.99, step: 0.01 },
  'momentum.maxHedges': { label: 'Max Hedges', description: 'Maximum hedges per session', min: 0, max: 5, step: 1 },
  'momentum.baseHedgeTrigger': { label: 'Base Hedge Trigger', description: 'Hedge when price drops below', unit: '¢', min: 0.40, max: 0.60, step: 0.01 },
  'momentum.slippageBps': { label: 'Slippage', description: 'Expected slippage in basis points', unit: 'bps', min: 0, max: 500, step: 10 },

  // Dual Entry
  'dualEntry.makerBidPrice': { label: 'Aggressive Bid', description: 'Lower maker bid price', unit: '¢', min: 0.40, max: 0.50, step: 0.01 },
  'dualEntry.makerAskPrice': { label: 'Conservative Bid', description: 'Higher maker bid price', unit: '¢', min: 0.50, max: 0.60, step: 0.01 },
  'dualEntry.investmentPerSide': { label: 'Investment Per Side', description: 'Dollar amount per side', unit: '$', min: 10, max: 500, step: 10 },
  'dualEntry.loserDropPct': { label: 'Loser Exit %', description: 'Sell loser at this % drop', unit: '%', min: 0.05, max: 0.30, step: 0.01 },
  'dualEntry.winnerGainPct': { label: 'Winner Exit %', description: 'Sell winner at this % gain', unit: '%', min: 0.10, max: 0.50, step: 0.01 },

  // Arbitrage (Frank-Wolfe)
  'arbitrage.alpha': { label: 'Alpha Extraction', description: 'Fraction of arbitrage to capture', unit: '%', min: 0.7, max: 0.99, step: 0.01 },
  'arbitrage.minDivergence': { label: 'Min Divergence', description: 'Minimum mispricing to trade', unit: '%', min: 0.01, max: 0.10, step: 0.005 },
  'arbitrage.maxIterations': { label: 'Max Iterations', description: 'Frank-Wolfe iteration limit', min: 10, max: 500, step: 10 },
  'arbitrage.minProfitAfterCosts': { label: 'Min Profit', description: 'Minimum profit after costs', unit: '%', min: 0.005, max: 0.05, step: 0.005 },
  'arbitrage.executionCost': { label: 'Execution Cost', description: 'Estimated execution cost', unit: '%', min: 0.01, max: 0.05, step: 0.005 },
  'arbitrage.liquidityParam': { label: 'LMSR Liquidity (b)', description: 'Market maker liquidity parameter', min: 10, max: 500, step: 10 },
  'arbitrage.positionSize': { label: 'Position Size', description: 'Dollar amount per arbitrage', unit: '$', min: 10, max: 500, step: 10 },

  // System
  'system.autoRestartOnNewMarket': { label: 'Auto-Restart', description: 'Restart sessions on new market window' },
  'system.paperTrading': { label: 'Paper Trading', description: 'Simulate trades (no real money)' },
  'system.portfolioValue': { label: 'Portfolio Value', description: 'Starting portfolio for tracking', unit: '$', min: 100, max: 100000, step: 100 },
}
