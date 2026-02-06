import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import type { TradingSession, PriceTick, PortfolioStats, StrategyAction, Position, Fill, PendingOrder, StrategyType } from "@/types"
import {
  checkDualEntry,
  executeDualEntry,
  processMakerFills,
  checkLoserExit,
  executeLoserExit,
  checkWinnerExit,
  executeWinnerExit,
  checkForceExit,
  executeForceExit,
  calculateDualPnl,
  checkIncompleteFillTimeout,
  executeIncompleteFillAbort,
} from "@/strategies/dualEntry"
import { logAudit } from "@/lib/auditLog"
import { tradingApi } from "@/lib/tradingApi"

// Strategy configuration - position size is configurable
let positionSizeConfig = 1 // Default $1 per side, configurable via UI

export function setPositionSize(size: number) {
  if (size >= 1 && size <= 100) {
    positionSizeConfig = size
    console.log(`[CONFIG] Position size updated: $${size}`)
  }
}

export function getPositionSize(): number {
  return positionSizeConfig
}

// Momentum warmup configuration - wait before first trade
let momentumWarmupSeconds = 60 // Default 60 seconds warmup

export function setMomentumWarmup(seconds: number) {
  if (seconds >= 0 && seconds <= 720) { // 0-12 minutes
    momentumWarmupSeconds = seconds
    console.log(`[CONFIG] Momentum warmup updated: ${seconds}s`)
  }
}

export function getMomentumWarmup(): number {
  return momentumWarmupSeconds
}

const CONFIG = {
  get positionSize() { return positionSizeConfig }, // Dynamic getter
  entryThreshold: 0.65,
  maxEntryPrice: 0.75, // Don't enter if price is already above this (missed the entry)
  scale2Threshold: 0.73,
  scale3Threshold: 0.80,
  // TAKE PROFIT - NEW!
  takeProfitEnabled: true, // Enable take-profit exits
  takeProfitThreshold: 0.95, // Exit when price hits 95¢ to lock gains
  // Hedge settings - adaptive based on entry and time
  baseHedgeTrigger: 0.48, // Floor: hedge when our side drops below 48¢
  hedgeTrailingPts: 0.17, // Trailing: hedge when price drops 17pts from entry
  // Time-decay hedge thresholds (tighten as we approach expiry)
  hedgeTrigger5minPlus: 0.48, // 5+ min remaining: hedge at 48¢
  hedgeTrigger3to5min: 0.50,  // 3-5 min remaining: hedge at 50¢
  hedgeTrigger1to3min: 0.52,  // 1-3 min remaining: hedge at 52¢
  hedgeTriggerUnder1min: 0.55, // <1 min remaining: hedge at 55¢
  // Hedge limits - prevent over-hedging
  maxHedges: 2, // Maximum 2 hedges per session - after that, just hold and wait
  minTimeForHedgeMinutes: 2, // Don't hedge with < 2 minutes left (market is decided)
  extremePriceNoHedge: { low: 0.15, high: 0.85 }, // Don't hedge when price is extreme (market decided)
  lateGameMinutes: 3,
  lateGameThreshold: 0.85,
  // Realism settings
  slippageBps: 100, // 1% slippage (100 basis points) - fills slightly worse than trigger
  confirmationTicks: 1, // Fill immediately on first tick (was 3, but too slow for volatile markets)
  cooldownAfterFillMs: 5000, // 5 second cooldown after a fill before next order (was 10s)
  // Liquidity requirements
  minLiquidityForEntry: 50, // Minimum $ liquidity to enter
  minLiquidityForHedge: 100, // Higher requirement for hedge (we NEED this to execute)
  // === NEW: TIME GATE (Fix #2) ===
  // Don't enter with less than 7 minutes remaining - late entries have no recovery time
  minTimeForEntryMinutes: 7, // Skip entries if <7 min left
  // === NEW: CHASE FILTER (Fix #3) ===
  // If price is >10¢ above threshold, reduce position size to avoid chasing spikes
  chaseFilterThreshold: 0.10, // If price > entryThreshold + 10¢, reduce size
  chaseFilterSizeMultiplier: 0.5, // Reduce to 50% of normal position when chasing
}

// Backend URLs
const API_URL = "http://localhost:3001/api"
const WS_URL = "ws://localhost:3002"

interface CryptoMarket {
  conditionId: string
  questionId: string
  yesTokenId: string
  noTokenId: string
  question: string
  startTime?: string
  endTime: string
  asset: string
  slug: string
  strikePrice?: number | null
}

interface CryptoPrices {
  BTC: { price: number; change24h: number }
  ETH: { price: number; change24h: number }
  SOL: { price: number; change24h: number }
  XRP: { price: number; change24h: number }
  timestamp: number
}

// Strategy mode: 'single' runs one strategy, 'compare' runs both side-by-side
type StrategyMode = 'single' | 'compare'
let strategyMode: StrategyMode = 'compare' // Default to comparison mode
let activeStrategy: StrategyType = 'MOMENTUM'

// Asset filter - which cryptos to trade
type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP'
let selectedAssets: Asset[] = ['BTC'] // Default to BTC only

export function setSelectedAssets(assets: Asset[]) {
  if (assets.length > 0) {
    selectedAssets = assets
    console.log(`[CONFIG] Selected assets: ${assets.join(', ')}`)
  }
}

export function getSelectedAssets(): Asset[] {
  return selectedAssets
}

export function setActiveStrategy(strategy: StrategyType) {
  activeStrategy = strategy
  console.log(`[STRATEGY] Switched to ${strategy}`)
}

export function getActiveStrategy(): StrategyType {
  return activeStrategy
}

export function setStrategyMode(mode: StrategyMode) {
  strategyMode = mode
  console.log(`[STRATEGY] Mode: ${mode}`)
}

export function getStrategyMode(): StrategyMode {
  return strategyMode
}

// Global price history ref - declared here so createSessionForStrategy can access it
// This is set by the hook and used to initialize sessions with existing history
let globalPriceHistoryRef: Map<string, PriceTick[]> | null = null

// === RE-ENTRY BUG FIX ===
// Track recently traded markets for DUAL_ENTRY to prevent re-entry
// Key: marketId (conditionId), Value: timestamp when entry was made
// Analysis showed DUAL_ENTRY was entering same market multiple times in rapid succession
const recentDualEntryMarkets: Map<string, number> = new Map()
const DUAL_ENTRY_COOLDOWN_MS = 20 * 60 * 1000 // 20 minute cooldown (covers full session + buffer)

function canEnterDualEntry(marketId: string): boolean {
  const lastEntry = recentDualEntryMarkets.get(marketId)
  if (!lastEntry) return true

  const elapsed = Date.now() - lastEntry
  if (elapsed >= DUAL_ENTRY_COOLDOWN_MS) {
    recentDualEntryMarkets.delete(marketId) // Clean up old entry
    return true
  }

  return false
}

function recordDualEntry(marketId: string): void {
  recentDualEntryMarkets.set(marketId, Date.now())

  // Periodically clean up old entries (keep map from growing unbounded)
  if (recentDualEntryMarkets.size > 100) {
    const now = Date.now()
    for (const [id, timestamp] of recentDualEntryMarkets.entries()) {
      if (now - timestamp >= DUAL_ENTRY_COOLDOWN_MS) {
        recentDualEntryMarkets.delete(id)
      }
    }
  }
}

// Create a session for a specific strategy
function createSessionForStrategy(market: CryptoMarket, strategy: StrategyType): TradingSession {
  const suffixMap: Record<StrategyType, string> = {
    'MOMENTUM': '-mom',
    'DUAL_ENTRY': '-dual',
    'ARBITRAGE': '-arb',
  }
  const suffix = suffixMap[strategy]
  // Use existing price history if available (important for session recreation)
  const existingHistory = globalPriceHistoryRef?.get(market.conditionId) || []
  const lastTick = existingHistory.length > 0 ? existingHistory[existingHistory.length - 1] : null

  if (existingHistory.length > 0) {
    console.log(`[SESSION] Creating ${strategy} session for ${market.asset} with ${existingHistory.length} historical ticks`)
  } else {
    console.log(`[SESSION] Creating ${strategy} session for ${market.asset} with NO history (will load later)`)
  }

  return {
    id: market.conditionId + suffix,
    marketId: market.conditionId,
    marketName: market.question,
    asset: market.asset,
    state: "WAITING",
    startTime: market.startTime ? new Date(market.startTime).getTime() : Date.now(),
    endTime: new Date(market.endTime).getTime(),
    primaryPosition: null,
    hedgedPairs: [],
    priceHistory: existingHistory,
    currentTick: lastTick,
    entryPrice: null,
    currentPnl: 0,
    realizedPnl: 0,
    actions: [],
    lastActionTime: null,
    pendingOrder: null,
    strikePrice: market.strikePrice || null,
    currentAssetPrice: null,
    slug: market.slug || null,
    strategyType: strategy,
    // Dual-Entry state
    dualEntryState: strategy === 'DUAL_ENTRY' ? 'WAITING' : undefined,
    dualPosition: null,
    dualTrade: null,
  }
}

// Create sessions from market - either one or two depending on mode
function createSessionsFromMarket(market: CryptoMarket): TradingSession[] {
  // ALWAYS create both for now to ensure we can test dual-entry
  // The UI will filter based on strategyMode
  console.log(`[SESSION] Creating sessions for ${market.asset}, mode: ${strategyMode}`)

  // Always create BOTH strategies - we want to compare them
  const sessions = [
    createSessionForStrategy(market, 'MOMENTUM'),
    createSessionForStrategy(market, 'DUAL_ENTRY'),
  ]

  console.log(`[SESSION] Created ${sessions.length} sessions: ${sessions.map(s => s.strategyType).join(', ')}`)
  return sessions
}

// Apply slippage to fill price (makes fill price worse for the trader)
function applySlippage(price: number, action: 'BUY' | 'SELL', slippageBps: number): number {
  const slippage = slippageBps / 10000 // Convert bps to decimal
  // When buying: pay slightly more (price goes up)
  // When selling: receive slightly less (price goes down)
  if (action === 'BUY') {
    return Math.min(0.99, price * (1 + slippage))
  } else {
    return Math.max(0.01, price * (1 - slippage))
  }
}

// Track if we've already initialized (survives React Strict Mode double-mount)
let globalInitialized = false

export function useLiveData() {
  const [sessions, setSessions] = useState<TradingSession[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [cryptoPrices, setCryptoPrices] = useState<CryptoPrices | null>(null)
  const [stats, setStats] = useState<PortfolioStats>({
    totalValue: 1000,
    dailyPnl: 0,
    dailyPnlPercent: 0,
    totalTrades: 0,
    winRate: 50,
    activeSessions: 0,
    connected: false,
  })
  
  // Persisted daily stats from database (survives restarts)
  const [persistedStats, setPersistedStats] = useState<{
    todayPnl: number
    todayWins: number
    todayLosses: number
    byStrategy: Record<string, { pnl: number; wins: number; losses: number; sessions: number }>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const marketsRef = useRef<Map<string, CryptoMarket>>(new Map())
  const wsRef = useRef<WebSocket | null>(null)
  const pricesRef = useRef<Map<string, { yesPrice: number; noPrice: number; yesLiquidity: number; noLiquidity: number; timestamp: number }>>(new Map())
  // Global price history per market (shared across strategies)
  const priceHistoryRef = useRef<Map<string, PriceTick[]>>(new Map())
  // Track which markets have successfully loaded history (prevents repeated fetches)
  const historyLoadedRef = useRef<Set<string>>(new Set())
  // Track if this specific hook instance has initialized
  const initializedRef = useRef(false)

  // Link to global ref so createSessionForStrategy can access existing history
  globalPriceHistoryRef = priceHistoryRef.current

  // Fetch persisted daily stats on startup
  useEffect(() => {
    const fetchPersistedStats = async () => {
      try {
        const res = await fetch(`${API_URL}/audit/daily-stats`)
        if (res.ok) {
          const data = await res.json()
          if (data) {
            console.log('[STATS] Loaded persisted daily stats:', data.today)
            setPersistedStats({
              todayPnl: data.today?.pnl || 0,
              todayWins: data.today?.wins || 0,
              todayLosses: data.today?.losses || 0,
              byStrategy: data.byStrategy || {},
            })
          }
        }
      } catch (e) {
        console.error('[STATS] Failed to fetch persisted stats:', e)
      }
    }
    fetchPersistedStats()
    
    // Refresh persisted stats every 60 seconds
    const interval = setInterval(fetchPersistedStats, 60000)
    return () => clearInterval(interval)
  }, [])

  // Check trading status on startup (auto-detect if live trading is enabled)
  useEffect(() => {
    const checkTradingStatus = async () => {
      try {
        const status = await tradingApi.getStatus()
        if (status.enabled) {
          console.log('[TRADING] Live trading is ENABLED')
          console.log('[TRADING] Wallet:', status.address)
          console.log('[TRADING] Position size: $' + status.config.investmentPerSide)
        } else {
          console.log('[TRADING] Paper trading mode (live trading not initialized)')
        }
      } catch (e) {
        console.log('[TRADING] Could not check trading status:', e)
      }
    }
    checkTradingStatus()
    
    // Re-check every 30 seconds in case it gets enabled
    const interval = setInterval(checkTradingStatus, 30000)
    return () => clearInterval(interval)
  }, [])

  // Check if a pending order should be created based on strategy
  const checkForNewOrder = useCallback(
    (session: TradingSession, tick: PriceTick): PendingOrder | null => {
      // Don't create new order if one is already pending
      if (session.pendingOrder) return null

      const now = Date.now()

      // Cooldown after last fill - prevent rapid-fire orders
      if (session.lastActionTime && (now - session.lastActionTime) < CONFIG.cooldownAfterFillMs) {
        return null
      }
      const remainingMs = session.endTime - now
      const remainingMin = remainingMs / 60000
      const isLateGame = remainingMin < CONFIG.lateGameMinutes
      const threshold = isLateGame ? CONFIG.lateGameThreshold : CONFIG.entryThreshold

      const yesPrice = tick.yesPrice
      const noPrice = tick.noPrice

      // Sanity check: YES + NO should be approximately 1.0 (allowing for spread)
      const priceSum = yesPrice + noPrice
      if (priceSum < 0.90 || priceSum > 1.10) {
        return null
      }

      if (session.state === "WAITING") {
        // WARMUP CHECK - Don't enter until warmup period has passed
        // This only applies to FIRST entry (no hedges and no previous entries)
        const hasEnteredBefore = session.hedgedPairs.length > 0 || session.actions.some(a => a.type === 'ENTER')
        if (!hasEnteredBefore) {
          const sessionStartTime = session.endTime - (15 * 60 * 1000) // Session starts 15 min before end
          const elapsedSeconds = (now - sessionStartTime) / 1000
          if (elapsedSeconds < momentumWarmupSeconds) {
            // Log warmup status every 10 ticks
            if (session.priceHistory.length % 10 === 0) {
              const remaining = Math.ceil(momentumWarmupSeconds - elapsedSeconds)
              console.log(`[WARMUP] ${session.asset} | Waiting ${remaining}s before first trade (warmup: ${momentumWarmupSeconds}s)`)
            }
            return null
          }
        }

        // === TIME GATE (Fix #2) ===
        // Don't enter with less than 7 minutes remaining - late entries have no recovery time
        // Analysis showed hedges in last 2-5 min have avg loss of -$2.58 vs -$0.39 for 10+ min
        if (remainingMin < CONFIG.minTimeForEntryMinutes) {
          if (session.priceHistory.length % 20 === 0) {
            console.log(`[TIME GATE] ${session.asset} | Only ${remainingMin.toFixed(1)}min left (need ${CONFIG.minTimeForEntryMinutes}min) - skipping entry`)
            logAudit(session.id, session.asset, 'MOMENTUM', 'ENTRY_SKIP', tick, session.endTime, {
              action: 'SKIP_ENTRY_TIME_GATE',
              reason: `Only ${remainingMin.toFixed(1)}min left (need ${CONFIG.minTimeForEntryMinutes}min) - late entries have no recovery time`,
              thresholds: { minTimeForEntryMinutes: CONFIG.minTimeForEntryMinutes, remainingMin },
            }, { severity: 'warning' })
          }
          return null
        }

        // After max hedges, we CAN still re-enter and scale - we just can't hedge anymore
        // Log that we're at max hedges but still looking
        if (session.hedgedPairs.length >= CONFIG.maxHedges && session.priceHistory.length % 60 === 0) {
          console.log(`[MAX HEDGES] ${session.asset} | Have ${session.hedgedPairs.length} hedges - can still enter/scale but NO MORE HEDGING`)
        }

        // Log that we're looking for re-entry after hedge
        if (session.hedgedPairs.length > 0 && session.priceHistory.length % 30 === 0) {
          console.log(`[RE-ENTRY] ${session.asset} | Looking for re-entry after ${session.hedgedPairs.length} hedge(s) | YES=${(yesPrice * 100).toFixed(1)}¢ NO=${(noPrice * 100).toFixed(1)}¢`)
        }

        // Only enter if price is in the sweet spot: above entry threshold but below max entry
        // This prevents chasing when price is already way up
        if (yesPrice >= threshold && yesPrice <= CONFIG.maxEntryPrice) {
          // Check liquidity
          if (tick.yesLiquidity < CONFIG.minLiquidityForEntry) {
            if (session.priceHistory.length % 20 === 0) {
              console.log(`[LIQUIDITY] ${session.asset} | YES liquidity too low: $${tick.yesLiquidity.toFixed(0)} (need $${CONFIG.minLiquidityForEntry})`)
              logAudit(session.id, session.asset, 'MOMENTUM', 'ENTRY_SKIP', tick, session.endTime, {
                action: 'SKIP_ENTRY',
                reason: `YES liquidity too low: $${tick.yesLiquidity.toFixed(0)} (need $${CONFIG.minLiquidityForEntry})`,
                thresholds: { entryThreshold: threshold, minLiquidity: CONFIG.minLiquidityForEntry },
              }, { severity: 'warning' })
            }
            return null
          }

          // === CHASE FILTER (Fix #3) ===
          // If price is >10¢ above threshold, reduce position size to avoid chasing spikes
          // Analysis showed entries at 75¢ when threshold is 65¢ = chasing parabolic moves
          const chaseAmount = yesPrice - CONFIG.entryThreshold
          const isChasing = chaseAmount > CONFIG.chaseFilterThreshold
          const positionMultiplier = isChasing ? CONFIG.chaseFilterSizeMultiplier : 1.0
          const adjustedSize = CONFIG.positionSize * 0.5 * positionMultiplier

          if (isChasing) {
            console.log(`[CHASE FILTER] ${session.asset} | YES at ${(yesPrice * 100).toFixed(1)}¢ is ${(chaseAmount * 100).toFixed(0)}¢ above threshold - reducing position to ${(positionMultiplier * 100).toFixed(0)}%`)
            logAudit(session.id, session.asset, 'MOMENTUM', 'CHASE_FILTER', tick, session.endTime, {
              action: 'POSITION_SIZE_REDUCED',
              reason: `Entry ${(chaseAmount * 100).toFixed(0)}¢ above threshold - chasing spike`,
              thresholds: { chaseFilterThreshold: CONFIG.chaseFilterThreshold, chaseAmount },
              calculation: `Position reduced from $${(CONFIG.positionSize * 0.5).toFixed(2)} to $${adjustedSize.toFixed(2)} (${(positionMultiplier * 100).toFixed(0)}%)`,
            }, { severity: 'warning' })
          }

          console.log(`[PENDING] ${session.asset} | YES hit ${(yesPrice * 100).toFixed(1)}¢ - creating pending order (liq: $${tick.yesLiquidity.toFixed(0)}${isChasing ? ', SIZE REDUCED' : ''})`)
          logAudit(session.id, session.asset, 'MOMENTUM', 'ENTRY_SIGNAL', tick, session.endTime, {
            action: 'ENTRY_SIGNAL',
            reason: `YES crossed ${(threshold * 100).toFixed(0)}¢ threshold${isChasing ? ' (chase filter applied)' : ''}`,
            thresholds: { entryThreshold: threshold, maxEntryPrice: CONFIG.maxEntryPrice },
            calculation: `${(yesPrice * 100).toFixed(1)}¢ >= ${(threshold * 100).toFixed(0)}¢ && <= ${(CONFIG.maxEntryPrice * 100).toFixed(0)}¢`,
          }, { severity: 'action' })
          return {
            type: "ENTER",
            side: "YES",
            triggerPrice: yesPrice,
            targetShares: adjustedSize / yesPrice,
            reason: `YES crossed ${(threshold * 100).toFixed(0)}¢ threshold${isChasing ? ' (chase filter: 50% size)' : ''}`,
            confirmationTicks: 1,
            createdAt: Date.now(),
          }
        }
        if (noPrice >= threshold && noPrice <= CONFIG.maxEntryPrice) {
          // Check liquidity
          if (tick.noLiquidity < CONFIG.minLiquidityForEntry) {
            if (session.priceHistory.length % 20 === 0) {
              console.log(`[LIQUIDITY] ${session.asset} | NO liquidity too low: $${tick.noLiquidity.toFixed(0)} (need $${CONFIG.minLiquidityForEntry})`)
              logAudit(session.id, session.asset, 'MOMENTUM', 'ENTRY_SKIP', tick, session.endTime, {
                action: 'SKIP_ENTRY',
                reason: `NO liquidity too low: $${tick.noLiquidity.toFixed(0)} (need $${CONFIG.minLiquidityForEntry})`,
                thresholds: { entryThreshold: threshold, minLiquidity: CONFIG.minLiquidityForEntry },
              }, { severity: 'warning' })
            }
            return null
          }

          // === CHASE FILTER (Fix #3) ===
          // If price is >10¢ above threshold, reduce position size to avoid chasing spikes
          const chaseAmountNo = noPrice - CONFIG.entryThreshold
          const isChasingNo = chaseAmountNo > CONFIG.chaseFilterThreshold
          const positionMultiplierNo = isChasingNo ? CONFIG.chaseFilterSizeMultiplier : 1.0
          const adjustedSizeNo = CONFIG.positionSize * 0.5 * positionMultiplierNo

          if (isChasingNo) {
            console.log(`[CHASE FILTER] ${session.asset} | NO at ${(noPrice * 100).toFixed(1)}¢ is ${(chaseAmountNo * 100).toFixed(0)}¢ above threshold - reducing position to ${(positionMultiplierNo * 100).toFixed(0)}%`)
            logAudit(session.id, session.asset, 'MOMENTUM', 'CHASE_FILTER', tick, session.endTime, {
              action: 'POSITION_SIZE_REDUCED',
              reason: `Entry ${(chaseAmountNo * 100).toFixed(0)}¢ above threshold - chasing spike`,
              thresholds: { chaseFilterThreshold: CONFIG.chaseFilterThreshold, chaseAmount: chaseAmountNo },
              calculation: `Position reduced from $${(CONFIG.positionSize * 0.5).toFixed(2)} to $${adjustedSizeNo.toFixed(2)} (${(positionMultiplierNo * 100).toFixed(0)}%)`,
            }, { severity: 'warning' })
          }

          console.log(`[PENDING] ${session.asset} | NO hit ${(noPrice * 100).toFixed(1)}¢ - creating pending order (liq: $${tick.noLiquidity.toFixed(0)}${isChasingNo ? ', SIZE REDUCED' : ''})`)
          logAudit(session.id, session.asset, 'MOMENTUM', 'ENTRY_SIGNAL', tick, session.endTime, {
            action: 'ENTRY_SIGNAL',
            reason: `NO crossed ${(threshold * 100).toFixed(0)}¢ threshold${isChasingNo ? ' (chase filter applied)' : ''}`,
            thresholds: { entryThreshold: threshold, maxEntryPrice: CONFIG.maxEntryPrice },
            calculation: `${(noPrice * 100).toFixed(1)}¢ >= ${(threshold * 100).toFixed(0)}¢ && <= ${(CONFIG.maxEntryPrice * 100).toFixed(0)}¢`,
          }, { severity: 'action' })
          return {
            type: "ENTER",
            side: "NO",
            triggerPrice: noPrice,
            targetShares: adjustedSizeNo / noPrice,
            reason: `NO crossed ${(threshold * 100).toFixed(0)}¢ threshold${isChasingNo ? ' (chase filter: 50% size)' : ''}`,
            confirmationTicks: 1,
            createdAt: Date.now(),
          }
        }
        // Log if we're skipping due to price being too high
        if ((yesPrice > CONFIG.maxEntryPrice || noPrice > CONFIG.maxEntryPrice) && session.priceHistory.length % 20 === 0) {
          console.log(`[SKIP] ${session.asset} | Price too high to enter: YES=${(yesPrice * 100).toFixed(1)}¢ NO=${(noPrice * 100).toFixed(1)}¢ (max entry: ${(CONFIG.maxEntryPrice * 100).toFixed(0)}¢)`)
        }
        return null
      }

      if ((session.state === "ENTRY" || session.state === "SCALING") && session.primaryPosition) {
        const pos = session.primaryPosition
        const currentPrice = pos.side === "YES" ? yesPrice : noPrice
        const oppPrice = pos.side === "YES" ? noPrice : yesPrice

        // ==========================================
        // TAKE PROFIT CHECK - Exit at 95¢ to lock in gains
        // ==========================================
        if (CONFIG.takeProfitEnabled && currentPrice >= CONFIG.takeProfitThreshold) {
          const unrealizedPnl = (currentPrice - pos.avgPrice) * pos.totalShares
          console.log(`[TAKE PROFIT] ${session.asset} | ${pos.side} hit ${(currentPrice * 100).toFixed(1)}¢ >= ${(CONFIG.takeProfitThreshold * 100).toFixed(0)}¢ - SELLING TO LOCK PROFIT!`)
          logAudit(session.id, session.asset, 'MOMENTUM', 'TAKE_PROFIT', tick, session.endTime, {
            action: 'TAKE_PROFIT',
            reason: `${pos.side} hit ${(currentPrice * 100).toFixed(0)}¢ - locking gains!`,
            thresholds: { takeProfitThreshold: CONFIG.takeProfitThreshold },
            calculation: `${(currentPrice * 100).toFixed(1)}¢ >= ${(CONFIG.takeProfitThreshold * 100).toFixed(0)}¢`,
          }, {
            severity: 'profit',
            position: {
              side: pos.side,
              shares: pos.totalShares,
              avgPrice: pos.avgPrice,
              unrealizedPnl,
            },
          })
          return {
            type: "CLOSE", // Using CLOSE type for profit-taking
            side: pos.side,
            triggerPrice: currentPrice,
            targetShares: pos.totalShares,
            reason: `Take profit: ${pos.side} hit ${(currentPrice * 100).toFixed(0)}¢ - locking gains!`,
            confirmationTicks: 1, // Fast exit
            createdAt: Date.now(),
          }
        }

        // Calculate adaptive hedge trigger based on:
        // 1. Trailing from entry: entryPrice - 17pts (if entered at 70¢, hedge at 53¢)
        // 2. Time-decay: tighter threshold as we approach expiration
        // 3. Floor: never below baseHedgeTrigger (48¢)
        const remainingMs = session.endTime - now
        const remainingMin = remainingMs / 60000

        // Time-based threshold
        let timeBasedTrigger = CONFIG.hedgeTrigger5minPlus
        if (remainingMin < 1) {
          timeBasedTrigger = CONFIG.hedgeTriggerUnder1min
        } else if (remainingMin < 3) {
          timeBasedTrigger = CONFIG.hedgeTrigger1to3min
        } else if (remainingMin < 5) {
          timeBasedTrigger = CONFIG.hedgeTrigger3to5min
        }

        // Trailing threshold based on entry price
        const trailingTrigger = session.entryPrice
          ? session.entryPrice - CONFIG.hedgeTrailingPts
          : CONFIG.baseHedgeTrigger

        // Use the HIGHEST of: time-based, trailing, or floor
        // This means we hedge EARLIER (tighter protection)
        const adaptiveHedgeTrigger = Math.max(
          CONFIG.baseHedgeTrigger,  // Floor: 48¢
          timeBasedTrigger,         // Time-based: 48-55¢
          trailingTrigger           // Trailing: entry - 17pts
        )

        // Check for hedge - with limits!
        // Rule 1: Max 2 hedges per session
        if (session.hedgedPairs.length >= CONFIG.maxHedges) {
          if (session.priceHistory.length % 30 === 0 && currentPrice < adaptiveHedgeTrigger) {
            console.log(`[HEDGE LIMIT] ${session.asset} | Already have ${session.hedgedPairs.length} hedges (max ${CONFIG.maxHedges}) - NO HEDGE, can still scale into winner`)
            logAudit(session.id, session.asset, 'MOMENTUM', 'HEDGE_SKIP', tick, session.endTime, {
              action: 'HEDGE_SKIP_MAX_REACHED',
              reason: `Already have ${session.hedgedPairs.length} hedges (max ${CONFIG.maxHedges})`,
              thresholds: { maxHedges: CONFIG.maxHedges, adaptiveHedgeTrigger },
            }, {
              severity: 'warning',
              position: { side: pos.side, shares: pos.totalShares, avgPrice: pos.avgPrice, hedgeCount: session.hedgedPairs.length },
            })
          }
          // Don't create more hedges, but continue to scale check below!
        }
        // Rule 2: Don't hedge with < 2 minutes left
        else if (remainingMin < CONFIG.minTimeForHedgeMinutes) {
          if (session.priceHistory.length % 30 === 0 && currentPrice < adaptiveHedgeTrigger) {
            console.log(`[HEDGE SKIP] ${session.asset} | Only ${remainingMin.toFixed(1)}min left (need ${CONFIG.minTimeForHedgeMinutes}min) - too late to hedge`)
            logAudit(session.id, session.asset, 'MOMENTUM', 'HEDGE_SKIP', tick, session.endTime, {
              action: 'HEDGE_SKIP_TIME',
              reason: `Only ${remainingMin.toFixed(1)}min left (need ${CONFIG.minTimeForHedgeMinutes}min) - too late to hedge`,
              thresholds: { minTimeForHedge: CONFIG.minTimeForHedgeMinutes, remainingMin },
            }, { severity: 'warning' })
          }
        }
        // Rule 3: Don't hedge when price is extreme (market is decided)
        else if (currentPrice <= CONFIG.extremePriceNoHedge.low || currentPrice >= CONFIG.extremePriceNoHedge.high) {
          if (session.priceHistory.length % 30 === 0) {
            console.log(`[HEDGE SKIP] ${session.asset} | Price ${(currentPrice * 100).toFixed(1)}¢ is extreme - market decided, no point hedging`)
            logAudit(session.id, session.asset, 'MOMENTUM', 'HEDGE_SKIP', tick, session.endTime, {
              action: 'HEDGE_SKIP_EXTREME',
              reason: `Price ${(currentPrice * 100).toFixed(1)}¢ is extreme - market decided`,
              thresholds: { extremeLow: CONFIG.extremePriceNoHedge.low, extremeHigh: CONFIG.extremePriceNoHedge.high },
            }, { severity: 'warning' })
          }
        }
        // All checks passed - can hedge
        else if (
          session.priceHistory.length >= 5 &&
          currentPrice < adaptiveHedgeTrigger
        ) {
          // Check liquidity on opposite side (where we need to hedge)
          const oppLiquidity = pos.side === "YES" ? tick.noLiquidity : tick.yesLiquidity
          if (oppLiquidity < CONFIG.minLiquidityForHedge) {
            console.log(`[LIQUIDITY WARNING] ${session.asset} | Need to hedge but ${pos.side === "YES" ? "NO" : "YES"} liquidity too low: $${oppLiquidity.toFixed(0)} (need $${CONFIG.minLiquidityForHedge})`)
            // Still try to hedge even with low liquidity - it's critical!
            // But log the warning
          }
          const triggerReason = trailingTrigger >= timeBasedTrigger
            ? `trailing (entry ${(session.entryPrice! * 100).toFixed(0)}¢ - 17pts)`
            : `time-decay (${remainingMin.toFixed(1)}min left)`
          console.log(`[PENDING] ${session.asset} | Hedge trigger: ${pos.side} broke ${(adaptiveHedgeTrigger * 100).toFixed(0)}¢ [${triggerReason}] at ${(currentPrice * 100).toFixed(1)}¢ (opp liq: $${oppLiquidity.toFixed(0)}) [hedge ${session.hedgedPairs.length + 1}/${CONFIG.maxHedges}]`)
          logAudit(session.id, session.asset, 'MOMENTUM', 'HEDGE_SIGNAL', tick, session.endTime, {
            action: 'HEDGE_SIGNAL',
            reason: `${pos.side} broke ${(adaptiveHedgeTrigger * 100).toFixed(0)}¢ [${triggerReason}]`,
            thresholds: { adaptiveHedgeTrigger, timeBasedTrigger, trailingTrigger, baseHedgeTrigger: CONFIG.baseHedgeTrigger },
            calculation: `${(currentPrice * 100).toFixed(1)}¢ < ${(adaptiveHedgeTrigger * 100).toFixed(1)}¢`,
          }, {
            severity: 'action',
            position: { side: pos.side, shares: pos.totalShares, avgPrice: pos.avgPrice, hedgeCount: session.hedgedPairs.length },
          })
          return {
            type: "HEDGE",
            side: pos.side === "YES" ? "NO" : "YES",
            triggerPrice: oppPrice,
            targetShares: pos.totalShares,
            reason: `${pos.side} broke ${(adaptiveHedgeTrigger * 100).toFixed(0)}¢ [${triggerReason}] - hedging at ${(oppPrice * 100).toFixed(0)}¢`,
            confirmationTicks: 1, // Hedge fills faster (1 tick)
            createdAt: Date.now(),
          }
        }

        // Check for scale - require minimum price increase from last fill
        const lastFill = pos.fills[pos.fills.length - 1]
        const lastFillPrice = lastFill.price
        const priceIncreasePct = (currentPrice - lastFillPrice) / lastFillPrice

        // Scale 2: price must be 3% higher than entry fill
        if (pos.fills.length === 1 && priceIncreasePct >= 0.03) {
          console.log(`[PENDING] ${session.asset} | Scale 2 trigger: ${(lastFillPrice * 100).toFixed(1)}¢ → ${(currentPrice * 100).toFixed(1)}¢ (+${(priceIncreasePct * 100).toFixed(1)}%)`)
          return {
            type: "SCALE",
            side: pos.side,
            triggerPrice: currentPrice,
            targetShares: (CONFIG.positionSize * 0.3) / currentPrice,
            reason: `+${(priceIncreasePct * 100).toFixed(0)}% from entry - adding 30%`,
            confirmationTicks: 1,
            createdAt: Date.now(),
          }
        }

        // Scale 3: price must be 3% higher than scale 2 fill
        if (pos.fills.length === 2 && priceIncreasePct >= 0.03) {
          console.log(`[PENDING] ${session.asset} | Scale 3 trigger: ${(lastFillPrice * 100).toFixed(1)}¢ → ${(currentPrice * 100).toFixed(1)}¢ (+${(priceIncreasePct * 100).toFixed(1)}%)`)
          return {
            type: "SCALE",
            side: pos.side,
            triggerPrice: currentPrice,
            targetShares: (CONFIG.positionSize * 0.2) / currentPrice,
            reason: `+${(priceIncreasePct * 100).toFixed(0)}% from last scale - adding final 20%`,
            confirmationTicks: 1,
            createdAt: Date.now(),
          }
        }
      }

      return null
    },
    []
  )

  // Check if pending order should fill or cancel
  const processPendingOrder = useCallback(
    (session: TradingSession, tick: PriceTick): { action: StrategyAction | null; updatedOrder: PendingOrder | null } => {
      const pending = session.pendingOrder
      if (!pending) return { action: null, updatedOrder: null }

      const currentPrice = pending.side === "YES" ? tick.yesPrice : tick.noPrice

      // For entry/scale: price must stay at or above trigger
      // For hedge: opposite side price must stay elevated
      const priceStillValid = pending.type === "HEDGE"
        ? currentPrice >= pending.triggerPrice * 0.95 // Hedge: opposite side still high
        : currentPrice >= pending.triggerPrice * 0.98 // Entry/scale: allow tiny pullback

      if (!priceStillValid) {
        // Price dropped below threshold - cancel the order
        console.log(`[CANCEL] ${session.asset} | ${pending.type} order cancelled - price dropped to ${(currentPrice * 100).toFixed(1)}¢ (trigger was ${(pending.triggerPrice * 100).toFixed(1)}¢)`)
        logAudit(session.id, session.asset, 'MOMENTUM', 'ORDER_CANCELLED', tick, session.endTime, {
          action: 'ORDER_CANCELLED',
          reason: `Price dropped to ${(currentPrice * 100).toFixed(1)}¢ (trigger was ${(pending.triggerPrice * 100).toFixed(1)}¢)`,
          orderType: pending.type,
          orderSide: pending.side,
          triggerPrice: pending.triggerPrice,
          currentPrice,
        }, { severity: 'warning' })
        return { action: null, updatedOrder: null }
      }

      // Price still valid - increment confirmation ticks
      const newTicks = pending.confirmationTicks + 1

      if (newTicks >= CONFIG.confirmationTicks) {
        // Order confirmed! Fill with slippage
        const fillPrice = applySlippage(currentPrice, 'BUY', CONFIG.slippageBps)
        console.log(`[FILL] ${session.asset} | ${pending.type} ${pending.side} - trigger ${(pending.triggerPrice * 100).toFixed(1)}¢ → fill ${(fillPrice * 100).toFixed(1)}¢ (${CONFIG.slippageBps/100}% slippage)`)

        logAudit(session.id, session.asset, 'MOMENTUM', 'ORDER_FILLED', tick, session.endTime, {
          action: 'ORDER_FILLED',
          reason: `${pending.type} confirmed after ${newTicks} ticks`,
          orderType: pending.type,
          orderSide: pending.side,
          triggerPrice: pending.triggerPrice,
          fillPrice,
          shares: pending.targetShares,
          slippageBps: CONFIG.slippageBps,
        }, { severity: 'action' })

        const action: StrategyAction = {
          type: pending.type,
          side: pending.side,
          reason: pending.reason,
          targetPrice: pending.triggerPrice,
          targetShares: pending.targetShares,
          timestamp: Date.now(),
          fillPrice: fillPrice,
        }
        return { action, updatedOrder: null }
      }

      // Still waiting for more ticks
      console.log(`[PENDING] ${session.asset} | ${pending.type} ${pending.side} - confirming ${newTicks}/${CONFIG.confirmationTicks} ticks at ${(currentPrice * 100).toFixed(1)}¢`)

      // Log first confirmation tick for debugging
      if (newTicks === 2) {
        logAudit(session.id, session.asset, 'MOMENTUM', 'ORDER_CONFIRMING', tick, session.endTime, {
          action: 'ORDER_CONFIRMING',
          reason: `Waiting for ${CONFIG.confirmationTicks - newTicks} more ticks`,
          orderType: pending.type,
          orderSide: pending.side,
          triggerPrice: pending.triggerPrice,
          currentPrice,
          confirmationTicks: newTicks,
          requiredTicks: CONFIG.confirmationTicks,
        }, { severity: 'info' })
      }

      return { action: null, updatedOrder: { ...pending, confirmationTicks: newTicks } }
    },
    []
  )

  // Execute action (paper trade OR live trade) - uses fillPrice with slippage
  const executeAction = useCallback(
    (session: TradingSession, action: StrategyAction): TradingSession => {
      const updated = { ...session }
      updated.actions = [...updated.actions, action]
      updated.pendingOrder = null // Clear pending order when filled
      updated.lastActionTime = Date.now() // Set cooldown timer

      // Use fillPrice (with slippage) if available, otherwise targetPrice
      const executionPrice = action.fillPrice || action.targetPrice

      // Check if live trading is enabled - if so, execute real orders
      if (tradingApi.isLive) {
        const market = marketsRef.current.get(session.marketId)
        if (market) {
          const tokenId = action.side === "YES" ? market.yesTokenId : market.noTokenId
          const amount = action.targetShares * executionPrice // Dollar amount for market orders

          console.log(`[LIVE TRADE] ${action.type} ${action.targetShares.toFixed(1)} ${action.side} @ ${(executionPrice * 100).toFixed(1)}¢ | Token: ${tokenId.slice(0, 12)}...`)

          // Execute the appropriate order type
          if (action.type === "ENTER" || action.type === "SCALE" || action.type === "HEDGE") {
            // Use market orders for immediate execution (buys)
            tradingApi.placeMarketOrder({
              tokenId,
              side: 'BUY',
              amount,
            }).then(result => {
              console.log(`[LIVE TRADE] ✅ ${action.type} order filled:`, result.status)
            }).catch(err => {
              console.error(`[LIVE TRADE] ❌ ${action.type} order failed:`, err.message)
            })
          } else if (action.type === "CLOSE") {
            // Sell existing shares (take profit / exit)
            tradingApi.placeMarketOrder({
              tokenId,
              side: 'SELL',
              amount: action.targetShares, // For sell, use shares not dollar amount
            }).then(result => {
              console.log(`[LIVE TRADE] ✅ CLOSE order filled:`, result.status)
            }).catch(err => {
              console.error(`[LIVE TRADE] ❌ CLOSE order failed:`, err.message)
            })
          }
        } else {
          console.error(`[LIVE TRADE] Market not found for session: ${session.marketId}`)
        }
      } else {
        console.log(`[PAPER TRADE] ${action.type} ${action.targetShares.toFixed(1)} ${action.side} @ ${(executionPrice * 100).toFixed(1)}¢ (trigger: ${(action.targetPrice * 100).toFixed(1)}¢)`)
      }

      // Log execution to audit log (only for valid execution types)
      // NOTE: We log AFTER the action modifies the session so we have correct P&L
      const tick = session.currentTick
      const executionEventMap: Record<string, 'ENTER_EXECUTED' | 'SCALE_EXECUTED' | 'HEDGE_EXECUTED' | 'CLOSE_EXECUTED' | null> = {
        'ENTER': 'ENTER_EXECUTED',
        'SCALE': 'SCALE_EXECUTED',
        'HEDGE': 'HEDGE_EXECUTED',
        'CLOSE': 'CLOSE_EXECUTED',
        'SOLD': null, // SOLD is dual-entry, not momentum
        'NONE': null,
      }
      const executionEvent = executionEventMap[action.type]

      if (action.type === "ENTER") {
        const fill: Fill = {
          side: action.side,
          price: executionPrice,
          shares: action.targetShares,
          timestamp: action.timestamp,
        }
        updated.primaryPosition = {
          side: action.side,
          fills: [fill],
          totalShares: action.targetShares,
          avgPrice: executionPrice,
          currentPrice: executionPrice,
        }
        updated.entryPrice = executionPrice
        updated.state = "ENTRY"
      }

      if (action.type === "SCALE" && updated.primaryPosition) {
        const fill: Fill = {
          side: action.side,
          price: executionPrice,
          shares: action.targetShares,
          timestamp: action.timestamp,
        }
        const pos = updated.primaryPosition
        const newTotalShares = pos.totalShares + action.targetShares
        const newAvgPrice =
          (pos.avgPrice * pos.totalShares + executionPrice * action.targetShares) /
          newTotalShares

        updated.primaryPosition = {
          ...pos,
          fills: [...pos.fills, fill],
          totalShares: newTotalShares,
          avgPrice: newAvgPrice,
        }
        updated.state = "SCALING"
      }

      if (action.type === "HEDGE" && updated.primaryPosition) {
        const hedgeFill: Fill = {
          side: action.side,
          price: executionPrice,
          shares: action.targetShares,
          timestamp: action.timestamp,
        }
        const hedgePosition: Position = {
          side: action.side,
          fills: [hedgeFill],
          totalShares: action.targetShares,
          avgPrice: executionPrice,
          currentPrice: executionPrice,
        }

        // Calculate locked P&L for hedged position
        // When we hold both YES and NO, one side will pay $1 per share
        // Total cost = cost of primary + cost of hedge
        // Payout = number of shares (whichever side wins pays $1)
        const primaryCost = updated.primaryPosition.avgPrice * updated.primaryPosition.totalShares
        const hedgeCost = executionPrice * action.targetShares
        const payout = Math.min(updated.primaryPosition.totalShares, action.targetShares) // Matched shares pay out $1
        const lockedPnl = payout - primaryCost - hedgeCost

        updated.hedgedPairs = [
          ...updated.hedgedPairs,
          {
            primary: { ...updated.primaryPosition },
            hedge: hedgePosition,
            lockedPnl,
          },
        ]
        updated.primaryPosition = null
        updated.entryPrice = null // Reset entry price so we can re-enter
        updated.realizedPnl += lockedPnl // Move locked P&L to realized
        updated.state = "WAITING" // Go back to WAITING to look for new entry!

        console.log(`[HEDGE COMPLETE] ${session.asset} | Locked P&L: ${lockedPnl.toFixed(2)} | Now watching for re-entry`)
      }

      // CLOSE action - Take Profit! Sell entire position
      let closeProfit = 0
      if (action.type === "CLOSE" && updated.primaryPosition) {
        const pos = updated.primaryPosition
        const sellPrice = executionPrice
        const cost = pos.avgPrice * pos.totalShares
        const revenue = sellPrice * pos.totalShares
        closeProfit = revenue - cost

        console.log(`[TAKE PROFIT] ${session.asset} | Sold ${pos.totalShares.toFixed(1)} ${pos.side} @ ${(sellPrice * 100).toFixed(1)}¢`)
        console.log(`[TAKE PROFIT] ${session.asset} | Cost: $${cost.toFixed(2)} | Revenue: $${revenue.toFixed(2)} | Profit: $${closeProfit.toFixed(2)}`)

        updated.realizedPnl += closeProfit
        updated.primaryPosition = null
        updated.entryPrice = null
        updated.state = "CLOSED" // Fully closed - took profit!
      }

      // NOW log to audit - AFTER all state changes so we have correct P&L
      if (tick && executionEvent) {
        // Determine severity and outcome based on action type
        let severity: 'action' | 'warning' | 'profit' | 'loss' = 'action'
        let outcome: { fillPrice: number; pnl?: number } | undefined = undefined

        if (action.type === 'HEDGE') {
          severity = 'warning'
          // For hedge, the lockedPnl was calculated above
          const lastHedge = updated.hedgedPairs[updated.hedgedPairs.length - 1]
          outcome = { fillPrice: executionPrice, pnl: lastHedge?.lockedPnl }
        } else if (action.type === 'CLOSE') {
          severity = closeProfit >= 0 ? 'profit' : 'loss'
          outcome = { fillPrice: executionPrice, pnl: closeProfit }
        }

        logAudit(session.id, session.asset, 'MOMENTUM', executionEvent, tick, session.endTime, {
          action: executionEvent,
          reason: action.reason,
          execution: {
            side: action.side,
            shares: action.targetShares,
            triggerPrice: action.targetPrice,
            fillPrice: executionPrice,
            slippageBps: CONFIG.slippageBps,
          },
        }, { severity, outcome })
      }

      return updated
    },
    []
  )

  // Update P&L
  // currentPnl = unrealized (open position) + locked (hedged pairs)
  // realizedPnl = accumulated from closed hedges (already added when hedge executes)
  // Total P&L for display = currentPnl + realizedPnl
  const updatePnl = useCallback((session: TradingSession, tick: PriceTick): TradingSession => {
    let unrealizedPnl = 0

    // Calculate unrealized P&L from open position
    if (session.primaryPosition) {
      const pos = session.primaryPosition
      const currentPrice = pos.side === "YES" ? tick.yesPrice : tick.noPrice
      const cost = pos.avgPrice * pos.totalShares
      const value = currentPrice * pos.totalShares
      unrealizedPnl = value - cost
    }

    // Add locked P&L from hedged pairs (these are essentially realized but waiting for settlement)
    let lockedPnl = 0
    for (const pair of session.hedgedPairs) {
      lockedPnl += pair.lockedPnl
    }

    // currentPnl is unrealized + locked from hedges
    // realizedPnl is already tracked separately and added to portfolio total
    return { ...session, currentPnl: unrealizedPnl + lockedPnl }
  }, [])

  // Process strategy logic for a session with a new tick
  const processSessionTick = useCallback((session: TradingSession, tick: PriceTick, newHistory: PriceTick[]): TradingSession => {
    if (session.state === "CLOSED") return session
    if (Date.now() >= session.endTime) {
      return { ...session, state: "CLOSED" as const }
    }

    // NOTE: Removed deduplication - it was blocking legitimate ticks and breaking the order flow
    // The duplicate audit log entries are acceptable; broken trading is not

    // Log SESSION_START on first tick for both strategies
    const isFirstTick = session.priceHistory.length === 0 && newHistory.length > 0
    if (isFirstTick) {
      logAudit(session.id, session.asset, session.strategyType, 'SESSION_START', tick, session.endTime,
        { action: 'SESSION_START', reason: `Started ${session.strategyType} session for ${session.asset}` },
        { severity: 'info' }
      )
    }

    // Guard: never replace history with data that has less time coverage
    // Check both length AND time span to prevent WS flooding from erasing backend history
    const newSpan = newHistory.length >= 2 ? newHistory[newHistory.length - 1].timestamp - newHistory[0].timestamp : 0
    const oldSpan = session.priceHistory.length >= 2 ? session.priceHistory[session.priceHistory.length - 1].timestamp - session.priceHistory[0].timestamp : 0
    const mergedHistory = (newHistory.length >= session.priceHistory.length && newSpan >= oldSpan * 0.5)
      ? newHistory
      : [...session.priceHistory.slice(-199), tick]

    let updated: TradingSession = {
      ...session,
      currentTick: tick,
      priceHistory: mergedHistory,
    }

    // Update position current price
    if (updated.primaryPosition) {
      const pos = updated.primaryPosition
      updated.primaryPosition = {
        ...pos,
        currentPrice: pos.side === "YES" ? tick.yesPrice : tick.noPrice,
      }
    }

    // ===== STRATEGY DISPATCH =====
    if (updated.strategyType === 'DUAL_ENTRY') {
      // --- DUAL-ENTRY STRATEGY ---
      const prevDualState = updated.dualEntryState

      if (checkForceExit(updated, tick)) {
        updated = executeForceExit(updated, tick)
        // Log force exit
        logAudit(updated.id, updated.asset, 'DUAL_ENTRY', 'FORCE_EXIT', tick, updated.endTime,
          { action: 'FORCE_EXIT', reason: `Time expired - closed position` },
          { severity: 'warning', outcome: { pnl: updated.realizedPnl } }
        )
        return updated
      }

      if (updated.dualEntryState === 'WAITING') {
        // === RE-ENTRY BUG FIX ===
        // Check if this market was traded recently (within 20 min cooldown)
        // Analysis found DUAL_ENTRY entering same market multiple times in rapid succession
        if (!canEnterDualEntry(updated.marketId)) {
          // Log periodically to avoid spam
          if (updated.priceHistory.length % 60 === 0) {
            console.log(`[DUAL RE-ENTRY BLOCKED] ${updated.asset} | Market traded recently - skipping (20min cooldown)`)
            logAudit(updated.id, updated.asset, 'DUAL_ENTRY', 'ENTRY_SKIP', tick, updated.endTime,
              { action: 'SKIP_REENTRY', reason: `Market traded within 20min cooldown - preventing duplicate entries` },
              { severity: 'warning' }
            )
          }
        } else {
          const entryAction = checkDualEntry(updated, tick)
          if (entryAction) {
            // Record this market as recently traded BEFORE executing
            recordDualEntry(updated.marketId)

            updated = executeDualEntry(updated, tick)

            // If live trading is enabled, place real dual-entry maker orders
            if (tradingApi.isLive) {
              const market = marketsRef.current.get(session.marketId)
              if (market) {
                console.log(`[LIVE TRADE] Placing dual-entry maker orders for ${session.asset}...`)
                tradingApi.placeDualEntryOrders({
                  yesTokenId: market.yesTokenId,
                  noTokenId: market.noTokenId,
                  marketId: session.marketId,
                }).then(result => {
                  console.log(`[LIVE TRADE] ✅ Dual-entry orders placed:`, result.orders?.length)
                }).catch(err => {
                  console.error(`[LIVE TRADE] ❌ Dual-entry orders failed:`, err.message)
                })
              }
            }

            // Log maker orders placed
            logAudit(updated.id, updated.asset, 'DUAL_ENTRY', 'MAKER_ORDER_PLACED', tick, updated.endTime,
              { action: 'PLACE_MAKER_ORDERS', reason: 'Placing 4 limit orders: YES@46¢, YES@54¢, NO@46¢, NO@54¢' },
              { severity: 'action' }
            )
          }
        }
      }

      // Process maker order fills when in ENTERING state
      if (updated.dualEntryState === 'ENTERING') {
        // BUG FIX #2: Check for incomplete fill timeout (one side filled, other didn't)
        if (checkIncompleteFillTimeout(updated)) {
          updated = executeIncompleteFillAbort(updated, tick)
          logAudit(updated.id, updated.asset, 'DUAL_ENTRY', 'INCOMPLETE_FILL_ABORT', tick, updated.endTime,
            { action: 'ABORT_INCOMPLETE', reason: `Timeout waiting for both sides to fill - aborted and sold partial position` },
            { severity: 'warning', outcome: { pnl: updated.realizedPnl } }
          )
          return updated
        }

        const prevState = updated.dualMakerState
        updated = processMakerFills(updated, tick)

        // Log if state changed to WAITING_LOSER (both sides filled)
        if (updated.dualEntryState === 'WAITING_LOSER' && prevDualState === 'ENTERING') {
          const pos = updated.dualPosition
          logAudit(updated.id, updated.asset, 'DUAL_ENTRY', 'MAKER_ORDER_FILLED', tick, updated.endTime,
            {
              action: 'BOTH_SIDES_FILLED',
              reason: `Position complete: YES @ ${((pos?.yesAvgPrice || 0) * 100).toFixed(0)}¢, NO @ ${((pos?.noAvgPrice || 0) * 100).toFixed(0)}¢`
            },
            { severity: 'action', position: { shares: pos?.yesShares } }
          )
        } else if (updated.dualMakerState?.filledYes !== prevState?.filledYes) {
          // YES side filled
          logAudit(updated.id, updated.asset, 'DUAL_ENTRY', 'MAKER_ORDER_FILLED', tick, updated.endTime,
            { action: 'YES_FILLED', reason: `YES maker order filled @ ${((updated.dualMakerState?.filledYes?.price || 0) * 100).toFixed(0)}¢` },
            { severity: 'info' }
          )
        } else if (updated.dualMakerState?.filledNo !== prevState?.filledNo) {
          // NO side filled
          logAudit(updated.id, updated.asset, 'DUAL_ENTRY', 'MAKER_ORDER_FILLED', tick, updated.endTime,
            { action: 'NO_FILLED', reason: `NO maker order filled @ ${((updated.dualMakerState?.filledNo?.price || 0) * 100).toFixed(0)}¢` },
            { severity: 'info' }
          )
        }
      }

      if (updated.dualEntryState === 'WAITING_LOSER') {
        const loserCheck = checkLoserExit(updated, tick)
        if (loserCheck) {
          updated = executeLoserExit(updated, loserCheck.side, loserCheck.price)

          // If live trading, sell the loser position
          if (tradingApi.isLive && updated.dualPosition) {
            const market = marketsRef.current.get(session.marketId)
            if (market) {
              const tokenId = loserCheck.side === "YES" ? market.yesTokenId : market.noTokenId
              const shares = loserCheck.side === "YES" ? updated.dualPosition.yesShares : updated.dualPosition.noShares
              console.log(`[LIVE TRADE] Selling loser ${loserCheck.side} (${shares.toFixed(1)} shares)...`)
              tradingApi.placeMarketOrder({
                tokenId,
                side: 'SELL',
                amount: shares,
              }).then(result => {
                console.log(`[LIVE TRADE] ✅ Loser sold:`, result.status)
              }).catch(err => {
                console.error(`[LIVE TRADE] ❌ Loser sell failed:`, err.message)
              })
            }
          }

          // Log loser exit
          logAudit(updated.id, updated.asset, 'DUAL_ENTRY', 'LOSER_EXIT', tick, updated.endTime,
            { action: 'SELL_LOSER', reason: `Sold loser ${loserCheck.side} @ ${(loserCheck.price * 100).toFixed(1)}¢` },
            { severity: 'action', outcome: { fillPrice: loserCheck.price } }
          )
        }
      }

      if (updated.dualEntryState === 'WAITING_WINNER') {
        const winnerCheck = checkWinnerExit(updated, tick)
        if (winnerCheck) {
          // Get position info BEFORE calling executeWinnerExit (which closes it)
          const winnerSide = updated.dualTrade?.winnerSide
          const winnerShares = winnerSide === "YES" ? updated.dualPosition?.yesShares : updated.dualPosition?.noShares

          updated = executeWinnerExit(updated, winnerCheck.price)

          // If live trading, sell the winner position
          if (tradingApi.isLive && winnerSide && winnerShares) {
            const market = marketsRef.current.get(session.marketId)
            if (market) {
              const tokenId = winnerSide === "YES" ? market.yesTokenId : market.noTokenId
              console.log(`[LIVE TRADE] Selling winner ${winnerSide} (${winnerShares.toFixed(1)} shares)...`)
              tradingApi.placeMarketOrder({
                tokenId,
                side: 'SELL',
                amount: winnerShares,
              }).then(result => {
                console.log(`[LIVE TRADE] ✅ Winner sold:`, result.status)
              }).catch(err => {
                console.error(`[LIVE TRADE] ❌ Winner sell failed:`, err.message)
              })
            }
          }

          // Log winner exit
          logAudit(updated.id, updated.asset, 'DUAL_ENTRY', 'WINNER_EXIT', tick, updated.endTime,
            { action: 'SELL_WINNER', reason: `Sold winner @ ${(winnerCheck.price * 100).toFixed(1)}¢` },
            { severity: updated.realizedPnl >= 0 ? 'profit' : 'loss', outcome: { fillPrice: winnerCheck.price, pnl: updated.realizedPnl } }
          )
        }
      }

      updated.currentPnl = calculateDualPnl(updated, tick)

    } else {
      // --- MOMENTUM STRATEGY ---
      // Debug: log every 10th tick
      if (updated.priceHistory.length % 10 === 0) {
        console.log(`[MOMENTUM] ${updated.asset} | state=${updated.state} | pending=${updated.pendingOrder?.type || 'none'} | YES=${(tick.yesPrice * 100).toFixed(1)}¢ NO=${(tick.noPrice * 100).toFixed(1)}¢`)
      }

      if (updated.pendingOrder) {
        console.log(`[MOMENTUM] ${updated.asset} | Processing pending ${updated.pendingOrder.type} order...`)
        const { action, updatedOrder } = processPendingOrder(updated, tick)
        updated.pendingOrder = updatedOrder
        if (action) {
          console.log(`[MOMENTUM] ${updated.asset} | ACTION RETURNED: ${action.type} ${action.side}`)
          updated = executeAction(updated, action)
        } else if (!updatedOrder) {
          console.log(`[MOMENTUM] ${updated.asset} | Order was CANCELLED`)
        }
      }

      if (!updated.pendingOrder) {
        const newOrder = checkForNewOrder(updated, tick)
        if (newOrder) {
          console.log(`[MOMENTUM] ${updated.asset} | NEW ORDER CREATED: ${newOrder.type} ${newOrder.side} @ ${(newOrder.triggerPrice * 100).toFixed(1)}¢`)
          updated.pendingOrder = newOrder
        }
      }

      updated = updatePnl(updated, tick)
    }

    return updated
  }, [checkForNewOrder, processPendingOrder, executeAction, updatePnl])

  // Handle WebSocket price updates
  const handlePriceUpdate = useCallback((tokenId: string, bestAsk: number | null, _bestBid: number | null, liquidity?: number) => {
    if (bestAsk === null) return

    // Find which market this token belongs to
    for (const [conditionId, market] of marketsRef.current.entries()) {
      let priceData = pricesRef.current.get(conditionId) || { yesPrice: 0.5, noPrice: 0.5, yesLiquidity: 0, noLiquidity: 0, timestamp: 0 }

      if (tokenId === market.yesTokenId) {
        priceData = { ...priceData, yesPrice: bestAsk, yesLiquidity: liquidity ?? priceData.yesLiquidity, timestamp: Date.now() }
        pricesRef.current.set(conditionId, priceData)
      } else if (tokenId === market.noTokenId) {
        priceData = { ...priceData, noPrice: bestAsk, noLiquidity: liquidity ?? priceData.noLiquidity, timestamp: Date.now() }
        pricesRef.current.set(conditionId, priceData)
      } else {
        continue
      }

      // Update session with new price - use tracked liquidity for both sides
      const tick: PriceTick = {
        timestamp: Date.now(),
        yesPrice: priceData.yesPrice,
        noPrice: priceData.noPrice,
        yesLiquidity: priceData.yesLiquidity,
        noLiquidity: priceData.noLiquidity,
      }

      // Store in global history - THROTTLED to prevent WS flooding
      // WS fires hundreds of times/sec for popular markets like BTC.
      // Without throttling, the 200-tick sliding window fills with WS-only
      // ticks in seconds, pushing out all backend historical data.
      const existingHistory = priceHistoryRef.current.get(conditionId) || []
      const lastHistTs = existingHistory.length > 0 ? existingHistory[existingHistory.length - 1].timestamp : 0
      if (tick.timestamp - lastHistTs >= 500) {
        const newHistory = [...existingHistory.slice(-200), tick]
        priceHistoryRef.current.set(conditionId, newHistory)
      }

      // Always update session current tick (strategy needs every price update)
      // but use the full history from ref (which preserves backend data)
      const currentHistory = priceHistoryRef.current.get(conditionId) || [tick]
      setSessions(prev => prev.map(session => {
        if (session.marketId !== conditionId) return session
        return processSessionTick(session, tick, currentHistory)
      }))
    }
  }, [processSessionTick])

  // Connect to WebSocket
  const connectWebSocket = useCallback((tokenIds: string[]) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Already connected, just subscribe
      wsRef.current.send(JSON.stringify({ action: 'subscribe', tokenIds }))
      return
    }

    console.log('[WS] Connecting to backend WebSocket...')
    const ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      console.log('[WS] Connected to backend')
      setStats(prev => ({ ...prev, connected: true }))
      // Subscribe to tokens
      ws.send(JSON.stringify({ action: 'subscribe', tokenIds }))
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'price') {
          handlePriceUpdate(data.tokenId, data.bestAsk, data.bestBid, data.liquidity)
        } else if (data.type === 'connected') {
          console.log('[WS] Server confirmed connection')
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    ws.onclose = () => {
      console.log('[WS] Disconnected')
      setStats(prev => ({ ...prev, connected: false }))
      // Attempt reconnect after 5 seconds
      setTimeout(() => {
        if (marketsRef.current.size > 0) {
          const allTokens: string[] = []
          for (const m of marketsRef.current.values()) {
            allTokens.push(m.yesTokenId, m.noTokenId)
          }
          connectWebSocket(allTokens)
        }
      }, 5000)
    }

    ws.onerror = (err) => {
      console.error('[WS] Error:', err)
    }

    wsRef.current = ws
  }, [handlePriceUpdate])

  // Fetch markets from backend
  const fetchMarkets = useCallback(async () => {
    const assetsParam = selectedAssets.join(',')
    console.log(`[LIVE] Fetching markets from backend (assets: ${assetsParam})...`)

    try {
      // Check if backend is running
      const healthCheck = await fetch(`${API_URL}/health`)
      if (!healthCheck.ok) {
        throw new Error("Backend not responding")
      }

      // Fetch 15-min markets with asset filter
      const response = await fetch(`${API_URL}/markets/crypto-15m?assets=${assetsParam}`)
      if (!response.ok) {
        throw new Error(`Backend error: ${response.status}`)
      }

      const markets: CryptoMarket[] = await response.json()
      console.log(`[LIVE] Got ${markets.length} markets from backend`)

      // If no 15-min, try hourly
      if (markets.length === 0) {
        console.log("[LIVE] No 15-min markets, trying hourly...")
        const hourlyResponse = await fetch(`${API_URL}/markets/crypto-hourly`)
        if (hourlyResponse.ok) {
          const hourlyMarkets = await hourlyResponse.json()
          markets.push(...hourlyMarkets)
          console.log(`[LIVE] Got ${hourlyMarkets.length} hourly markets`)
        }
      }

      return markets
    } catch (err: any) {
      console.error("[LIVE] Backend error:", err.message)
      if (err.message.includes("Failed to fetch") || err.message.includes("not responding")) {
        setError("Backend not running. Start it with: cd backend && npm install && npm start")
      } else {
        setError(err.message)
      }
      return []
    }
  }, [])

  // Initialize and refresh markets periodically
  useEffect(() => {
    let mounted = true
    let refreshInterval: ReturnType<typeof setInterval> | null = null

    // Prevent double-initialization from React Strict Mode
    if (globalInitialized && !initializedRef.current) {
      console.log("[LIVE] Skipping duplicate initialization (Strict Mode)")
      initializedRef.current = true
      return () => {
        mounted = false
      }
    }

    const loadMarkets = async (isRefresh = false) => {
      if (isRefresh) {
        console.log("[LIVE] Refreshing markets...")
      } else {
        console.log("[LIVE] Initializing...")
        globalInitialized = true
        initializedRef.current = true
      }

      const markets = await fetchMarkets()

      if (!mounted) return

      if (markets.length === 0) {
        console.log("[LIVE] No markets found")
        if (!error && !isRefresh) {
          setError("No active markets found. Markets may be between windows.")
        }
        // On refresh with no markets, keep existing closed sessions for history
        return
      }

      console.log(`[LIVE] Successfully found ${markets.length} markets`)
      setError(null)

      // Check for new markets or expired markets
      const existingIds = new Set(marketsRef.current.keys())
      const newMarketIds = new Set(markets.map(m => m.conditionId))

      // Find truly new markets (not already tracked)
      const newMarkets = markets.filter(m => !existingIds.has(m.conditionId))

      // Find expired markets (in our list but not in API response)
      const expiredIds = [...existingIds].filter(id => !newMarketIds.has(id))

      if (newMarkets.length > 0 || expiredIds.length > 0) {
        console.log(`[LIVE] Changes detected: ${newMarkets.length} new, ${expiredIds.length} expired`)
        if (newMarkets.length > 0) {
          console.log(`[LIVE] New markets:`, newMarkets.map(m => `${m.asset} (${m.conditionId.slice(0,8)}...)`))
        }
        if (expiredIds.length > 0) {
          console.log(`[LIVE] Expired markets:`, expiredIds.map(id => id.slice(0,8) + '...'))
        }

        // Add new markets to ref
        newMarkets.forEach(m => marketsRef.current.set(m.conditionId, m))

        // Update sessions
        setSessions(prev => {
          // Mark expired sessions as closed
          let updated = prev.map(s => {
            if (expiredIds.includes(s.marketId) && s.state !== "CLOSED") {
              // For dual-entry, also set dualEntryState to CLOSED
              if (s.strategyType === 'DUAL_ENTRY') {
                return { ...s, state: "CLOSED" as const, dualEntryState: "CLOSED" as const }
              }
              return { ...s, state: "CLOSED" as const }
            }
            return s
          })

          // Add new sessions (flatMap because createSessionsFromMarket returns array)
          const newSessions = newMarkets.flatMap(createSessionsFromMarket)
          console.log(`[LIVE] Creating ${newSessions.length} new sessions:`, newSessions.map(s => `${s.asset}-${s.strategyType}`))
          updated = [...updated, ...newSessions]

          // IMPORTANT: Ensure every market has BOTH strategy types
          const marketIds = new Set(updated.map(s => s.marketId))
          for (const marketId of marketIds) {
            const marketSessions = updated.filter(s => s.marketId === marketId)
            const hasMomentum = marketSessions.some(s => s.strategyType === 'MOMENTUM')
            const hasDualEntry = marketSessions.some(s => s.strategyType === 'DUAL_ENTRY')

            const market = marketsRef.current.get(marketId)
            if (market) {
              if (!hasMomentum) {
                console.log(`[LIVE] Missing MOMENTUM for ${market.asset}, creating...`)
                updated.push(createSessionForStrategy(market, 'MOMENTUM'))
              }
              if (!hasDualEntry) {
                console.log(`[LIVE] Missing DUAL_ENTRY for ${market.asset}, creating...`)
                updated.push(createSessionForStrategy(market, 'DUAL_ENTRY'))
              }
            }
          }

          console.log(`[LIVE] Total sessions after update: ${updated.length}`)
          console.log(`[LIVE] Sessions by type:`, {
            momentum: updated.filter(s => s.strategyType === 'MOMENTUM').length,
            dualEntry: updated.filter(s => s.strategyType === 'DUAL_ENTRY').length,
          })
          return updated
        })

        // Note: Don't auto-change selection on refresh - let user keep their selection

        // Subscribe to new tokens - handle WebSocket state
        if (newMarkets.length > 0) {
          const newTokenIds: string[] = []
          for (const m of newMarkets) {
            newTokenIds.push(m.yesTokenId, m.noTokenId)
          }

          console.log(`[LIVE] New markets detected! Token IDs:`, newTokenIds.map(t => t.slice(0, 12) + '...'))

          // First, tell the backend to force reconnect to Polymarket
          fetch(`${API_URL}/reconnect`, { method: 'POST' })
            .then(() => console.log(`[LIVE] Backend reconnect triggered`))
            .catch(e => console.log(`[LIVE] Backend reconnect failed:`, e))

          // Then subscribe via our WebSocket
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            console.log(`[LIVE] Frontend WS is open, subscribing to new tokens...`)
            wsRef.current.send(JSON.stringify({ action: 'subscribe', tokenIds: newTokenIds }))
            console.log(`[LIVE] Sent subscription request for ${newTokenIds.length} new tokens`)
          } else {
            // WebSocket not ready, reconnect with all tokens
            console.log(`[LIVE] Frontend WS not ready (state: ${wsRef.current?.readyState}), reconnecting...`)
            const allTokenIds: string[] = []
            for (const m of marketsRef.current.values()) {
              allTokenIds.push(m.yesTokenId, m.noTokenId)
            }
            connectWebSocket(allTokenIds)
          }

          // Fetch initial prices AND price history for new markets via REST
          // Use retry mechanism since backend may need time to accumulate data
          const fetchHistoryWithRetry = async (market: CryptoMarket, retryCount = 0) => {
            const maxRetries = 6 // Retry for up to 30 seconds (5s intervals)
            const retryDelay = 5000 // 5 seconds between retries

            try {
              const sessionStart = market.startTime ? new Date(market.startTime).getTime() : Date.now()
              const sessionEnd = new Date(market.endTime).getTime()

              // Fetch saved price history from backend
              const historyRes = await fetch(`${API_URL}/price-history/${market.conditionId}`)
              let savedHistory: PriceTick[] = []

              if (historyRes.ok) {
                const historyData = await historyRes.json()
                if (historyData.ticks && historyData.ticks.length > 0) {
                  // Filter to only include ticks within THIS session's time window
                  savedHistory = historyData.ticks.filter((tick: PriceTick) =>
                    tick.timestamp >= sessionStart && tick.timestamp <= sessionEnd
                  )
                  if (savedHistory.length > 0) {
                    console.log(`[LIVE] Loaded ${savedHistory.length}/${historyData.ticks.length} historical ticks for ${market.asset} (filtered to session window)`)
                  }
                }
              }

              // Fetch current price
              const priceRes = await fetch(`${API_URL}/price/${market.yesTokenId}/${market.noTokenId}?marketId=${market.conditionId}`)
              if (priceRes.ok) {
                const priceData = await priceRes.json()

                if (retryCount === 0) {
                  console.log(`[LIVE] Got initial price for ${market.asset}: YES=${(priceData.yesPrice * 100).toFixed(1)}¢, NO=${(priceData.noPrice * 100).toFixed(1)}¢`)
                }

                // Store initial prices (including liquidity)
                pricesRef.current.set(market.conditionId, {
                  yesPrice: priceData.yesPrice,
                  noPrice: priceData.noPrice,
                  yesLiquidity: priceData.yesLiquidity || 0,
                  noLiquidity: priceData.noLiquidity || 0,
                  timestamp: Date.now()
                })

                // Create current tick
                const tick: PriceTick = {
                  timestamp: Date.now(),
                  yesPrice: priceData.yesPrice,
                  noPrice: priceData.noPrice,
                  yesLiquidity: priceData.yesLiquidity || 100,
                  noLiquidity: priceData.noLiquidity || 100,
                }

                // Combine: existing accumulated history + saved history from backend + current tick
                const existingHistory = priceHistoryRef.current.get(market.conditionId) || []

                // Merge and sort by timestamp, dedupe
                const allTicks = [...existingHistory, ...savedHistory, tick]
                  .sort((a, b) => a.timestamp - b.timestamp)
                const combinedHistory = allTicks
                  .filter((t, i, arr) => i === 0 || t.timestamp - arr[i-1].timestamp >= 400) // dedupe within 400ms
                  .slice(-200)

                priceHistoryRef.current.set(market.conditionId, combinedHistory)

                setSessions(prev => prev.map(session => {
                  if (session.marketId !== market.conditionId) return session
                  // Guard: never replace history with fewer ticks
                  const safeHistory = combinedHistory.length >= session.priceHistory.length
                    ? combinedHistory
                    : [...session.priceHistory.slice(-199), tick]
                  return {
                    ...session,
                    currentTick: tick,
                    priceHistory: safeHistory,
                  }
                }))

                // Calculate time span of history
                if (combinedHistory.length >= 2) {
                  const timeSpanSec = (combinedHistory[combinedHistory.length - 1].timestamp - combinedHistory[0].timestamp) / 1000

                  // If we have at least 10 seconds of history, stop retrying
                  if (timeSpanSec >= 10) {
                    historyLoadedRef.current.add(market.conditionId)
                    console.log(`[LIVE] ${market.asset} has ${combinedHistory.length} ticks spanning ${timeSpanSec.toFixed(0)}s - history loaded`)
                    return // Done
                  }
                }

                // If history is too short and we haven't exceeded retries, schedule another fetch
                if (retryCount < maxRetries) {
                  setTimeout(() => fetchHistoryWithRetry(market, retryCount + 1), retryDelay)
                }
              }
            } catch (e) {
              console.log(`[LIVE] Failed to get price for ${market.asset}:`, e)
              // Retry on error
              if (retryCount < maxRetries) {
                setTimeout(() => fetchHistoryWithRetry(market, retryCount + 1), retryDelay)
              }
            }
          }

          // Start fetching for all new markets after a short delay
          setTimeout(() => {
            for (const m of newMarkets) {
              fetchHistoryWithRetry(m)
            }
          }, 500)
        }
      }

      // On initial load, set up everything
      if (!isRefresh) {
        marketsRef.current.clear()
        markets.forEach(m => marketsRef.current.set(m.conditionId, m))

        // Check if we already have sessions (from previous mount in Strict Mode)
        // Don't overwrite them if they have data
        setSessions(prev => {
          if (prev.length > 0) {
            console.log(`[LIVE] Keeping ${prev.length} existing sessions (Strict Mode recovery)`)
            return prev
          }
          const newSessions = markets.flatMap(createSessionsFromMarket)
          console.log(`[LIVE] Creating ${newSessions.length} new sessions`)
          return newSessions
        })

        // Only set initial selection if we don't have one
        setSelectedSessionId(prev => {
          if (prev) return prev
          const firstMarket = markets[0]
          return firstMarket ? firstMarket.conditionId + '-mom' : null
        })

        const tokenIds: string[] = []
        for (const m of markets) {
          tokenIds.push(m.yesTokenId, m.noTokenId)
        }
        connectWebSocket(tokenIds)

        // Fetch initial prices AND price history for all markets on initial load
        // Helper function with retry for loading history
        const fetchMarketHistoryWithRetry = async (market: CryptoMarket, retryCount = 0) => {
          const maxRetries = 6 // Retry for up to 30 seconds
          const retryDelay = 5000

          try {
            const sessionStart = market.startTime ? new Date(market.startTime).getTime() : Date.now()
            const sessionEnd = new Date(market.endTime).getTime()

            // Fetch saved price history from backend
            const historyRes = await fetch(`${API_URL}/price-history/${market.conditionId}`)
            let savedHistory: PriceTick[] = []

            if (historyRes.ok) {
              const historyData = await historyRes.json()
              if (historyData.ticks && historyData.ticks.length > 0) {
                savedHistory = historyData.ticks.filter((tick: PriceTick) =>
                  tick.timestamp >= sessionStart && tick.timestamp <= sessionEnd
                )
                if (savedHistory.length > 0) {
                  console.log(`[LIVE] Loaded ${savedHistory.length}/${historyData.ticks.length} historical ticks for ${market.asset}`)
                }
              }
            }

            // Fetch current price
            const priceRes = await fetch(`${API_URL}/price/${market.yesTokenId}/${market.noTokenId}?marketId=${market.conditionId}`)
            if (priceRes.ok) {
              const priceData = await priceRes.json()

              if (retryCount === 0) {
                console.log(`[LIVE] Initial price for ${market.asset}: YES=${(priceData.yesPrice * 100).toFixed(1)}¢, NO=${(priceData.noPrice * 100).toFixed(1)}¢`)
              }

              pricesRef.current.set(market.conditionId, {
                yesPrice: priceData.yesPrice,
                noPrice: priceData.noPrice,
                yesLiquidity: priceData.yesLiquidity || 0,
                noLiquidity: priceData.noLiquidity || 0,
                timestamp: Date.now()
              })

              const tick: PriceTick = {
                timestamp: Date.now(),
                yesPrice: priceData.yesPrice,
                noPrice: priceData.noPrice,
                yesLiquidity: priceData.yesLiquidity || 100,
                noLiquidity: priceData.noLiquidity || 100,
              }

              // Merge and sort by timestamp
              const existingHistory = priceHistoryRef.current.get(market.conditionId) || []
              const allTicks = [...existingHistory, ...savedHistory, tick]
                .sort((a, b) => a.timestamp - b.timestamp)
              const combinedHistory = allTicks
                .filter((t, i, arr) => i === 0 || t.timestamp - arr[i-1].timestamp >= 400)
                .slice(-200)

              priceHistoryRef.current.set(market.conditionId, combinedHistory)

              setSessions(prev => prev.map(session => {
                if (session.marketId !== market.conditionId) return session
                // Guard: never replace history with fewer ticks
                const safeHistory = combinedHistory.length >= session.priceHistory.length
                  ? combinedHistory
                  : [...session.priceHistory.slice(-199), tick]
                return {
                  ...session,
                  currentTick: tick,
                  priceHistory: safeHistory,
                }
              }))

              // Check if we have enough history
              if (combinedHistory.length >= 2) {
                const timeSpanSec = (combinedHistory[combinedHistory.length - 1].timestamp - combinedHistory[0].timestamp) / 1000
                if (timeSpanSec >= 10) {
                  historyLoadedRef.current.add(market.conditionId)
                  console.log(`[LIVE] ${market.asset} has ${combinedHistory.length} ticks spanning ${timeSpanSec.toFixed(0)}s`)
                  return
                }
              }

              // Retry if history is too short
              if (retryCount < maxRetries) {
                setTimeout(() => fetchMarketHistoryWithRetry(market, retryCount + 1), retryDelay)
              }
            }
          } catch (e) {
            console.log(`[LIVE] Failed to get price for ${market.asset}:`, e)
            if (retryCount < maxRetries) {
              setTimeout(() => fetchMarketHistoryWithRetry(market, retryCount + 1), retryDelay)
            }
          }
        }

        setTimeout(() => {
          console.log(`[LIVE] Fetching initial prices and history for ${markets.length} markets...`)
          for (const m of markets) {
            fetchMarketHistoryWithRetry(m)
          }
        }, 1000)
      }
    }

    // Initial load
    loadMarkets(false)

    // Refresh every 30 seconds to catch new markets
    refreshInterval = setInterval(() => {
      loadMarkets(true)
    }, 30000)

    // Also refresh at the start of each 15-minute window
    const scheduleWindowRefresh = () => {
      const now = Date.now()
      const currentWindow = Math.floor(now / (15 * 60 * 1000))
      const nextWindow = (currentWindow + 1) * 15 * 60 * 1000
      const msUntilNext = nextWindow - now + 5000 // Add 5s buffer for market to be available

      const nextTime = new Date(nextWindow + 5000)
      console.log(`[LIVE] Next 15-min window refresh scheduled for ${nextTime.toLocaleTimeString()} (in ${Math.round(msUntilNext / 1000)}s)`)

      setTimeout(() => {
        if (mounted) {
          console.log(`[LIVE] ⏰ 15-MINUTE WINDOW CHANGE - Refreshing markets and reconnecting...`)

          // Force backend to reconnect to Polymarket
          fetch(`${API_URL}/reconnect`, { method: 'POST' })
            .then(() => console.log(`[LIVE] Backend reconnect triggered for window change`))
            .catch(e => console.log(`[LIVE] Backend reconnect failed:`, e))

          // Close and reconnect our WebSocket too
          if (wsRef.current) {
            console.log(`[LIVE] Closing frontend WebSocket for fresh connection...`)
            wsRef.current.close()
            wsRef.current = null
          }

          // Load new markets
          loadMarkets(true)
          scheduleWindowRefresh() // Schedule next
        }
      }, msUntilNext)
    }
    scheduleWindowRefresh()

    return () => {
      mounted = false
      if (refreshInterval) clearInterval(refreshInterval)
      if (wsRef.current) {
        wsRef.current.close()
      }
      // Reset global state on unmount (for hot reload scenarios)
      // But NOT in Strict Mode where we want to preserve state
      // globalInitialized = false  // Commented out - let it persist
    }
    // Note: selectedSessionId intentionally excluded to prevent re-init on selection change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchMarkets, connectWebSocket, error])

  // Fetch crypto prices periodically
  useEffect(() => {
    let mounted = true

    const fetchCryptoPrices = async () => {
      try {
        const res = await fetch(`${API_URL}/crypto-prices`)
        if (res.ok) {
          const data: CryptoPrices = await res.json()
          if (mounted) {
            setCryptoPrices(data)

            // Update sessions with current asset prices
            setSessions(prev => prev.map(session => {
              const assetKey = session.asset as keyof Omit<CryptoPrices, 'timestamp'>
              const priceData = data[assetKey]
              if (priceData) {
                return { ...session, currentAssetPrice: priceData.price }
              }
              return session
            }))
          }
        }
      } catch (e) {
        // Silently fail - crypto prices are optional
      }
    }

    // Fetch immediately
    fetchCryptoPrices()

    // Then every 10 seconds
    const interval = setInterval(fetchCryptoPrices, 10000)

    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [])

  // Poll market prices every 1 second to ensure continuous chart data (like simulation)
  useEffect(() => {
    let mounted = true
    let pollIntervalId: ReturnType<typeof setInterval> | null = null

    const pollMarketPrices = async () => {
      if (!mounted || marketsRef.current.size === 0) return

      for (const [conditionId, market] of marketsRef.current.entries()) {
        try {
          // If we have very little history and haven't loaded yet, try to fetch from backend
          let existingHistory = priceHistoryRef.current.get(conditionId) || []
          const timeSpan = existingHistory.length >= 2
            ? existingHistory[existingHistory.length - 1].timestamp - existingHistory[0].timestamp
            : 0

          // Only fetch backend history if:
          // 1. We have less than 10 seconds of data
          // 2. We haven't already loaded history for this market
          if (timeSpan < 10000 && !historyLoadedRef.current.has(conditionId)) {
            try {
              const historyRes = await fetch(`${API_URL}/price-history/${conditionId}`)
              if (historyRes.ok) {
                const historyData = await historyRes.json()
                if (historyData.ticks && historyData.ticks.length > 0) {
                  // Filter to session window
                  const sessionStart = market.startTime ? new Date(market.startTime).getTime() : Date.now() - 15 * 60 * 1000
                  const sessionEnd = new Date(market.endTime).getTime()
                  const filteredTicks = historyData.ticks.filter((tick: PriceTick) =>
                    tick.timestamp >= sessionStart && tick.timestamp <= sessionEnd
                  )

                  if (filteredTicks.length > 0) {
                    // Merge with existing history
                    const merged = [...existingHistory, ...filteredTicks]
                      .sort((a: PriceTick, b: PriceTick) => a.timestamp - b.timestamp)
                      .filter((t: PriceTick, i: number, arr: PriceTick[]) => i === 0 || t.timestamp - arr[i-1].timestamp >= 400)
                      .slice(-200)

                    // Calculate merged time span
                    const mergedTimeSpan = merged.length >= 2
                      ? merged[merged.length - 1].timestamp - merged[0].timestamp
                      : 0

                    // Only update if we got meaningful data (>= 10 seconds of history)
                    if (mergedTimeSpan >= 10000) {
                      existingHistory = merged
                      priceHistoryRef.current.set(conditionId, existingHistory)
                      historyLoadedRef.current.add(conditionId)
                      console.log(`[POLL] History loaded for ${market.asset}: ${existingHistory.length} ticks spanning ${(mergedTimeSpan / 1000).toFixed(0)}s`)
                    }
                  }
                }
              }
            } catch {
              // Ignore history fetch errors
            }
          }

          // Pass marketId to backend for price history storage
          const priceRes = await fetch(`${API_URL}/price/${market.yesTokenId}/${market.noTokenId}?marketId=${conditionId}`)
          if (!priceRes.ok || !mounted) continue

          const priceData = await priceRes.json()

          // Store in prices ref (including liquidity from API)
          pricesRef.current.set(conditionId, {
            yesPrice: priceData.yesPrice,
            noPrice: priceData.noPrice,
            yesLiquidity: priceData.yesLiquidity || 0,
            noLiquidity: priceData.noLiquidity || 0,
            timestamp: Date.now()
          })

          // Create tick and add to global history
          const tick: PriceTick = {
            timestamp: Date.now(),
            yesPrice: priceData.yesPrice,
            noPrice: priceData.noPrice,
            yesLiquidity: priceData.yesLiquidity || 100,
            noLiquidity: priceData.noLiquidity || 100,
          }

          // Re-fetch existing history in case it was loaded above
          existingHistory = priceHistoryRef.current.get(conditionId) || []
          const newHistory = [...existingHistory.slice(-200), tick]
          priceHistoryRef.current.set(conditionId, newHistory)

          // Update all sessions for this market AND run strategy logic
          setSessions(prev => prev.map(session => {
            if (session.marketId !== conditionId) return session
            return processSessionTick(session, tick, newHistory)
          }))
        } catch {
          // Silently fail individual market fetches
        }
      }
    }

    // Delay start to allow initial history fetch to complete
    const startDelay = setTimeout(() => {
      if (!mounted) return
      // Poll every 1 second for smooth chart updates
      pollMarketPrices() // Run immediately
      pollIntervalId = setInterval(pollMarketPrices, 1000)
    }, 1500) // Wait 1.5s for initial load to complete

    return () => {
      mounted = false
      clearTimeout(startDelay)
      if (pollIntervalId) clearInterval(pollIntervalId)
    }
  }, [processSessionTick])

  // Update stats - combines persisted (from DB) + live in-memory sessions
  useEffect(() => {
    // In-memory session P&L (current sessions since app started)
    const livePnl = sessions.reduce((sum, s) => sum + s.currentPnl + s.realizedPnl, 0)
    const activeSessions = sessions.filter(s => s.state !== "CLOSED").length
    const totalTrades = sessions.reduce((sum, s) => sum + s.actions.filter(a => a.type !== "NONE").length, 0)

    // Calculate win rate from closed sessions with positions
    const closedWithTrades = sessions.filter(s =>
      s.state === "CLOSED" && (s.primaryPosition || s.realizedPnl !== 0 || s.hedgedPairs.length > 0)
    )
    const liveWins = closedWithTrades.filter(s => (s.currentPnl + s.realizedPnl) > 0).length
    const liveLosses = closedWithTrades.filter(s => (s.currentPnl + s.realizedPnl) < 0).length

    // Add persisted daily stats (from DB) to get true daily totals
    // Note: Persisted stats include COMPLETED sessions, so we add them to live unrealized
    const persistedPnl = persistedStats?.todayPnl || 0
    const persistedWins = persistedStats?.todayWins || 0
    const persistedLosses = persistedStats?.todayLosses || 0

    // Total = persisted completed + live (unrealized + realized)
    // But we need to avoid double-counting: persisted includes all COMPLETED sessions
    // while live includes current sessions (some of which may be persisted when closed)
    // For simplicity, we show: persisted (DB) + live unrealized only
    const totalPnl = persistedPnl + livePnl
    
    // Win rate combines persisted + live
    const totalWins = persistedWins + liveWins
    const totalLosses = persistedLosses + liveLosses
    const totalCompleted = totalWins + totalLosses
    const winRate = totalCompleted > 0 ? Math.round((totalWins / totalCompleted) * 100) : 50

    setStats(prev => ({
      ...prev,
      dailyPnl: totalPnl,
      dailyPnlPercent: (totalPnl / prev.totalValue) * 100,
      activeSessions,
      totalTrades,
      winRate,
    }))
  }, [sessions, persistedStats])

  const selectedSession = sessions.find(s => s.id === selectedSessionId) || null

  // Strategy switcher - updates future sessions
  const switchStrategy = useCallback((strategy: StrategyType) => {
    setActiveStrategy(strategy)
    // Note: Existing sessions keep their strategy, only new sessions use the new strategy
    console.log(`[STRATEGY] Will use ${strategy} for new sessions`)
  }, [])

  // Toggle comparison mode
  const toggleCompareMode = useCallback((enabled: boolean) => {
    setStrategyMode(enabled ? 'compare' : 'single')
  }, [])

  // Calculate per-strategy P&L for comparison (combines persisted + live)
  const strategyStats = useMemo(() => {
    const momentumSessions = sessions.filter(s => s.strategyType === 'MOMENTUM')
    const dualEntrySessions = sessions.filter(s => s.strategyType === 'DUAL_ENTRY')

    const liveMomentumPnl = momentumSessions.reduce((sum, s) => sum + s.currentPnl + s.realizedPnl, 0)
    const liveDualEntryPnl = dualEntrySessions.reduce((sum, s) => sum + s.currentPnl + s.realizedPnl, 0)

    // Add persisted stats from database
    const persistedMomentum = persistedStats?.byStrategy?.['MOMENTUM'] || { pnl: 0, sessions: 0 }
    const persistedDualEntry = persistedStats?.byStrategy?.['DUAL_ENTRY'] || { pnl: 0, sessions: 0 }

    return {
      momentum: {
        pnl: liveMomentumPnl + persistedMomentum.pnl,
        sessions: momentumSessions.length + persistedMomentum.sessions,
        activeSessions: momentumSessions.filter(s => s.state !== 'CLOSED').length,
      },
      dualEntry: {
        pnl: liveDualEntryPnl + persistedDualEntry.pnl,
        sessions: dualEntrySessions.length + persistedDualEntry.sessions,
        activeSessions: dualEntrySessions.filter(s => s.state !== 'CLOSED' && s.dualEntryState !== 'CLOSED').length,
      },
    }
  }, [sessions, persistedStats])

  return {
    sessions,
    selectedSession,
    selectedSessionId,
    setSelectedSessionId,
    stats,
    error,
    cryptoPrices,
    activeStrategy,
    switchStrategy,
    strategyMode,
    toggleCompareMode,
    strategyStats,
  }
}
