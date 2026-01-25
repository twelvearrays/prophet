// Types matching the strategy engine

export type Side = 'YES' | 'NO'
export type SessionState = 'WAITING' | 'ENTRY' | 'SCALING' | 'HEDGED' | 'CLOSED'

// Strategy types
export type StrategyType = 'MOMENTUM' | 'DUAL_ENTRY'

// Dual-Entry specific states
export type DualEntryState =
  | 'WAITING'           // Not yet entered
  | 'ENTERING'          // Maker orders placed, waiting for fills
  | 'HEDGED'            // Holding both YES and NO (neutral)
  | 'WAITING_LOSER'     // Waiting for loser threshold
  | 'WAITING_WINNER'    // Loser sold, waiting for winner threshold
  | 'CLOSED'            // All positions closed

// Maker order for dual-entry strategy
export interface MakerOrder {
  side: Side
  price: number
  shares: number
  placedAt: number
  status: 'PENDING' | 'FILLED' | 'CANCELLED'
}

// Dual-entry maker state (tracks pending limit orders)
export interface DualMakerState {
  pendingOrders: MakerOrder[]
  filledYes: MakerOrder | null
  filledNo: MakerOrder | null
}

// Dual-Entry position (holds both sides)
export interface DualPosition {
  yesShares: number
  noShares: number
  yesAvgPrice: number
  noAvgPrice: number
  yesEntryFee: number
  noEntryFee: number
  entryTime: number
}

// Dual-Entry trade record
export interface DualEntryTrade {
  loserSide: Side | null
  loserExitPrice: number | null
  loserExitTime: number | null
  loserReturn: number | null
  loserExitFee: number | null
  winnerSide: Side | null
  winnerExitPrice: number | null
  winnerExitTime: number | null
  winnerReturn: number | null
  winnerExitFee: number | null
}

export interface PriceTick {
  timestamp: number
  yesPrice: number
  noPrice: number
  yesLiquidity: number
  noLiquidity: number
}

// Liquidity status for UI display
export interface LiquidityStatus {
  yesLiquidity: number
  noLiquidity: number
  canEnter: boolean
  canHedge: boolean
  warning?: string
}

export interface Fill {
  side: Side
  price: number
  shares: number
  timestamp: number
}

export interface Position {
  side: Side
  fills: Fill[]
  totalShares: number
  avgPrice: number
  currentPrice: number
}

export interface HedgedPair {
  primary: Position
  hedge: Position
  lockedPnl: number
}

export interface TradingSession {
  id: string
  marketId: string
  marketName: string
  asset: string
  state: SessionState
  startTime: number
  endTime: number
  primaryPosition: Position | null
  hedgedPairs: HedgedPair[]
  priceHistory: PriceTick[]
  currentTick: PriceTick | null
  entryPrice: number | null
  currentPnl: number
  realizedPnl: number
  actions: StrategyAction[]
  lastActionTime?: number | null  // Timestamp of last action for cooldown
  pendingOrder?: PendingOrder | null  // Order waiting for price confirmation
  // Market reference prices
  strikePrice?: number | null      // Target price from market (e.g., $104,500)
  currentAssetPrice?: number | null // Live asset price (e.g., BTC at $104,523)
  slug?: string | null  // Polymarket URL slug for direct link

  // Strategy selection
  strategyType: StrategyType

  // Dual-Entry specific fields
  dualEntryState?: DualEntryState
  dualPosition?: DualPosition | null
  dualTrade?: DualEntryTrade | null
  dualMakerState?: DualMakerState | null  // Maker order tracking
}

export interface StrategyAction {
  type: 'ENTER' | 'SCALE' | 'HEDGE' | 'CLOSE' | 'NONE'
  side: Side
  reason: string
  targetPrice: number
  targetShares: number
  timestamp: number
  fillPrice?: number  // Actual fill price with slippage (only set when executed)
}

// Pending order waiting for confirmation ticks
export interface PendingOrder {
  type: 'ENTER' | 'SCALE' | 'HEDGE'
  side: Side
  triggerPrice: number  // Price that triggered this order
  targetShares: number
  reason: string
  confirmationTicks: number  // How many ticks price has been at/above trigger
  createdAt: number
}

export interface PortfolioStats {
  totalValue: number
  dailyPnl: number
  dailyPnlPercent: number
  totalTrades: number
  winRate: number
  activeSessions: number
  connected: boolean
}

export interface SimulatedMarket {
  id: string
  asset: string
  question: string
  endTime: Date
  currentPrice: number
}
