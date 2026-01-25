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
} from "@/strategies/dualEntry"
import { logAudit } from "@/lib/auditLog"

// Strategy configuration
const CONFIG = {
  positionSize: 30,
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

// Create a session for a specific strategy
function createSessionForStrategy(market: CryptoMarket, strategy: StrategyType): TradingSession {
  const suffix = strategy === 'DUAL_ENTRY' ? '-dual' : '-mom'
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
  const [error, setError] = useState<string | null>(null)

  const marketsRef = useRef<Map<string, CryptoMarket>>(new Map())
  const wsRef = useRef<WebSocket | null>(null)
  const pricesRef = useRef<Map<string, { yesPrice: number; noPrice: number; timestamp: number }>>(new Map())
  // Global price history per market (shared across strategies)
  const priceHistoryRef = useRef<Map<string, PriceTick[]>>(new Map())
  // Track if this specific hook instance has initialized
  const initializedRef = useRef(false)

  // Link to global ref so createSessionForStrategy can access existing history
  globalPriceHistoryRef = priceHistoryRef.current

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
          console.log(`[PENDING] ${session.asset} | YES hit ${(yesPrice * 100).toFixed(1)}¢ - creating pending order (liq: $${tick.yesLiquidity.toFixed(0)})`)
          logAudit(session.id, session.asset, 'MOMENTUM', 'ENTRY_SIGNAL', tick, session.endTime, {
            action: 'ENTRY_SIGNAL',
            reason: `YES crossed ${(threshold * 100).toFixed(0)}¢ threshold`,
            thresholds: { entryThreshold: threshold, maxEntryPrice: CONFIG.maxEntryPrice },
            calculation: `${(yesPrice * 100).toFixed(1)}¢ >= ${(threshold * 100).toFixed(0)}¢ && <= ${(CONFIG.maxEntryPrice * 100).toFixed(0)}¢`,
          }, { severity: 'action' })
          return {
            type: "ENTER",
            side: "YES",
            triggerPrice: yesPrice,
            targetShares: (CONFIG.positionSize * 0.5) / yesPrice,
            reason: `YES crossed ${(threshold * 100).toFixed(0)}¢ threshold`,
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
          console.log(`[PENDING] ${session.asset} | NO hit ${(noPrice * 100).toFixed(1)}¢ - creating pending order (liq: $${tick.noLiquidity.toFixed(0)})`)
          logAudit(session.id, session.asset, 'MOMENTUM', 'ENTRY_SIGNAL', tick, session.endTime, {
            action: 'ENTRY_SIGNAL',
            reason: `NO crossed ${(threshold * 100).toFixed(0)}¢ threshold`,
            thresholds: { entryThreshold: threshold, maxEntryPrice: CONFIG.maxEntryPrice },
            calculation: `${(noPrice * 100).toFixed(1)}¢ >= ${(threshold * 100).toFixed(0)}¢ && <= ${(CONFIG.maxEntryPrice * 100).toFixed(0)}¢`,
          }, { severity: 'action' })
          return {
            type: "ENTER",
            side: "NO",
            triggerPrice: noPrice,
            targetShares: (CONFIG.positionSize * 0.5) / noPrice,
            reason: `NO crossed ${(threshold * 100).toFixed(0)}¢ threshold`,
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

  // Execute action (paper trade) - uses fillPrice with slippage
  const executeAction = useCallback(
    (session: TradingSession, action: StrategyAction): TradingSession => {
      const updated = { ...session }
      updated.actions = [...updated.actions, action]
      updated.pendingOrder = null // Clear pending order when filled
      updated.lastActionTime = Date.now() // Set cooldown timer

      // Use fillPrice (with slippage) if available, otherwise targetPrice
      const executionPrice = action.fillPrice || action.targetPrice

      console.log(`[PAPER TRADE] ${action.type} ${action.targetShares.toFixed(1)} ${action.side} @ ${(executionPrice * 100).toFixed(1)}¢ (trigger: ${(action.targetPrice * 100).toFixed(1)}¢)`)

      // Log execution to audit log (only for valid execution types)
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
      if (tick && executionEvent) {
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
        }, { severity: action.type === 'HEDGE' ? 'warning' : 'action' })
      }

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
      if (action.type === "CLOSE" && updated.primaryPosition) {
        const pos = updated.primaryPosition
        const sellPrice = executionPrice
        const cost = pos.avgPrice * pos.totalShares
        const revenue = sellPrice * pos.totalShares
        const profit = revenue - cost

        console.log(`[TAKE PROFIT] ${session.asset} | Sold ${pos.totalShares.toFixed(1)} ${pos.side} @ ${(sellPrice * 100).toFixed(1)}¢`)
        console.log(`[TAKE PROFIT] ${session.asset} | Cost: $${cost.toFixed(2)} | Revenue: $${revenue.toFixed(2)} | Profit: $${profit.toFixed(2)}`)

        updated.realizedPnl += profit
        updated.primaryPosition = null
        updated.entryPrice = null
        updated.state = "CLOSED" // Fully closed - took profit!
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

    let updated: TradingSession = {
      ...session,
      currentTick: tick,
      priceHistory: newHistory,
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
        const entryAction = checkDualEntry(updated, tick)
        if (entryAction) {
          updated = executeDualEntry(updated, tick)
          // Log maker orders placed
          logAudit(updated.id, updated.asset, 'DUAL_ENTRY', 'MAKER_ORDER_PLACED', tick, updated.endTime,
            { action: 'PLACE_MAKER_ORDERS', reason: 'Placing 4 limit orders: YES@46¢, YES@54¢, NO@46¢, NO@54¢' },
            { severity: 'action' }
          )
        }
      }

      // Process maker order fills when in ENTERING state
      if (updated.dualEntryState === 'ENTERING') {
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
          updated = executeWinnerExit(updated, winnerCheck.price)
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
      let priceData = pricesRef.current.get(conditionId) || { yesPrice: 0.5, noPrice: 0.5, timestamp: 0 }

      if (tokenId === market.yesTokenId) {
        priceData = { ...priceData, yesPrice: bestAsk, timestamp: Date.now() }
        pricesRef.current.set(conditionId, priceData)
      } else if (tokenId === market.noTokenId) {
        priceData = { ...priceData, noPrice: bestAsk, timestamp: Date.now() }
        pricesRef.current.set(conditionId, priceData)
      } else {
        continue
      }

      // Update session with new price
      const tick: PriceTick = {
        timestamp: Date.now(),
        yesPrice: priceData.yesPrice,
        noPrice: priceData.noPrice,
        yesLiquidity: liquidity || 100,
        noLiquidity: 100,
      }

      // Store in global history (shared across all sessions for this market)
      const existingHistory = priceHistoryRef.current.get(conditionId) || []
      const newHistory = [...existingHistory.slice(-500), tick]
      priceHistoryRef.current.set(conditionId, newHistory)

      setSessions(prev => prev.map(session => {
        if (session.marketId !== conditionId) return session
        return processSessionTick(session, tick, newHistory)
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
    console.log("[LIVE] Fetching markets from backend...")

    try {
      // Check if backend is running
      const healthCheck = await fetch(`${API_URL}/health`)
      if (!healthCheck.ok) {
        throw new Error("Backend not responding")
      }

      // Fetch 15-min markets
      const response = await fetch(`${API_URL}/markets/crypto-15m`)
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
          // Check for markets that only have momentum but not dual-entry
          const marketIds = new Set(updated.map(s => s.marketId))
          for (const marketId of marketIds) {
            const marketSessions = updated.filter(s => s.marketId === marketId)
            const hasMomentum = marketSessions.some(s => s.strategyType === 'MOMENTUM')
            const hasDualEntry = marketSessions.some(s => s.strategyType === 'DUAL_ENTRY')

            if (hasMomentum && !hasDualEntry) {
              // Missing dual-entry - create it
              const market = marketsRef.current.get(marketId)
              if (market) {
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

          // Also fetch initial prices AND price history for new markets via REST
          setTimeout(async () => {
            for (const m of newMarkets) {
              try {
                // Fetch saved price history from backend first
                const historyRes = await fetch(`${API_URL}/price-history/${m.conditionId}`)
                let savedHistory: PriceTick[] = []
                const sessionStart = m.startTime ? new Date(m.startTime).getTime() : Date.now()
                const sessionEnd = new Date(m.endTime).getTime()

                if (historyRes.ok) {
                  const historyData = await historyRes.json()
                  if (historyData.ticks && historyData.ticks.length > 0) {
                    // Filter to only include ticks within THIS session's time window
                    savedHistory = historyData.ticks.filter((tick: PriceTick) =>
                      tick.timestamp >= sessionStart && tick.timestamp <= sessionEnd
                    )
                    console.log(`[LIVE] Loaded ${savedHistory.length}/${historyData.ticks.length} historical ticks for ${m.asset} (filtered to session window)`)
                  }
                }

                // Fetch current price
                const priceRes = await fetch(`${API_URL}/price/${m.yesTokenId}/${m.noTokenId}?marketId=${m.conditionId}`)
                if (priceRes.ok) {
                  const priceData = await priceRes.json()
                  console.log(`[LIVE] Got initial price for ${m.asset}: YES=${(priceData.yesPrice * 100).toFixed(1)}¢, NO=${(priceData.noPrice * 100).toFixed(1)}¢`)

                  // Store initial prices
                  pricesRef.current.set(m.conditionId, {
                    yesPrice: priceData.yesPrice,
                    noPrice: priceData.noPrice,
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

                  // Combine saved history with current tick
                  const combinedHistory = [...savedHistory, tick].slice(-500)
                  priceHistoryRef.current.set(m.conditionId, combinedHistory)

                  setSessions(prev => prev.map(session => {
                    if (session.marketId !== m.conditionId) return session
                    return {
                      ...session,
                      currentTick: tick,
                      priceHistory: combinedHistory,
                    }
                  }))
                }
              } catch (e) {
                console.log(`[LIVE] Failed to get initial price for ${m.asset}:`, e)
              }
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
        setTimeout(async () => {
          console.log(`[LIVE] Fetching initial prices and history for ${markets.length} markets...`)
          for (const m of markets) {
            try {
              // Fetch saved price history from backend first
              const historyRes = await fetch(`${API_URL}/price-history/${m.conditionId}`)
              let savedHistory: PriceTick[] = []
              const sessionStart = m.startTime ? new Date(m.startTime).getTime() : Date.now()
              const sessionEnd = new Date(m.endTime).getTime()

              if (historyRes.ok) {
                const historyData = await historyRes.json()
                if (historyData.ticks && historyData.ticks.length > 0) {
                  // Filter to only include ticks within THIS session's time window
                  savedHistory = historyData.ticks.filter((tick: PriceTick) =>
                    tick.timestamp >= sessionStart && tick.timestamp <= sessionEnd
                  )
                  console.log(`[LIVE] Loaded ${savedHistory.length}/${historyData.ticks.length} historical ticks for ${m.asset} (filtered to session window)`)
                }
              }

              // Fetch current price
              const priceRes = await fetch(`${API_URL}/price/${m.yesTokenId}/${m.noTokenId}?marketId=${m.conditionId}`)
              if (priceRes.ok) {
                const priceData = await priceRes.json()
                console.log(`[LIVE] Initial price for ${m.asset}: YES=${(priceData.yesPrice * 100).toFixed(1)}¢, NO=${(priceData.noPrice * 100).toFixed(1)}¢`)

                pricesRef.current.set(m.conditionId, {
                  yesPrice: priceData.yesPrice,
                  noPrice: priceData.noPrice,
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

                // Combine saved history with current tick
                const combinedHistory = [...savedHistory, tick].slice(-500)
                priceHistoryRef.current.set(m.conditionId, combinedHistory)

                setSessions(prev => prev.map(session => {
                  if (session.marketId !== m.conditionId) return session
                  return {
                    ...session,
                    currentTick: tick,
                    priceHistory: combinedHistory,
                  }
                }))
              }
            } catch (e) {
              console.log(`[LIVE] Failed to get initial price for ${m.asset}:`, e)
            }
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
          // If we don't have history for this market yet, try to fetch it from backend
          let existingHistory = priceHistoryRef.current.get(conditionId) || []
          if (existingHistory.length === 0) {
            try {
              const historyRes = await fetch(`${API_URL}/price-history/${conditionId}`)
              if (historyRes.ok) {
                const historyData = await historyRes.json()
                if (historyData.ticks && historyData.ticks.length > 0) {
                  existingHistory = historyData.ticks
                  priceHistoryRef.current.set(conditionId, existingHistory)
                  console.log(`[POLL] Loaded ${existingHistory.length} historical ticks for ${market.asset}`)
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

          // Store in prices ref
          pricesRef.current.set(conditionId, {
            yesPrice: priceData.yesPrice,
            noPrice: priceData.noPrice,
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
          const newHistory = [...existingHistory.slice(-500), tick]
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

  // Update stats
  useEffect(() => {
    const totalPnl = sessions.reduce((sum, s) => sum + s.currentPnl + s.realizedPnl, 0)
    const activeSessions = sessions.filter(s => s.state !== "CLOSED").length
    const totalTrades = sessions.reduce((sum, s) => sum + s.actions.filter(a => a.type !== "NONE").length, 0)

    setStats(prev => ({
      ...prev,
      dailyPnl: totalPnl,
      dailyPnlPercent: (totalPnl / prev.totalValue) * 100,
      activeSessions,
      totalTrades,
    }))
  }, [sessions])

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

  // Calculate per-strategy P&L for comparison
  const strategyStats = useMemo(() => {
    const momentumSessions = sessions.filter(s => s.strategyType === 'MOMENTUM')
    const dualEntrySessions = sessions.filter(s => s.strategyType === 'DUAL_ENTRY')

    const momentumPnl = momentumSessions.reduce((sum, s) => sum + s.currentPnl + s.realizedPnl, 0)
    const dualEntryPnl = dualEntrySessions.reduce((sum, s) => sum + s.currentPnl + s.realizedPnl, 0)

    return {
      momentum: {
        pnl: momentumPnl,
        sessions: momentumSessions.length,
        activeSessions: momentumSessions.filter(s => s.state !== 'CLOSED').length,
      },
      dualEntry: {
        pnl: dualEntryPnl,
        sessions: dualEntrySessions.length,
        activeSessions: dualEntrySessions.filter(s => s.state !== 'CLOSED' && s.dualEntryState !== 'CLOSED').length,
      },
    }
  }, [sessions])

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
