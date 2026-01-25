/**
 * Dual-Entry Strategy for Polymarket 15-min Crypto Markets
 *
 * Core Thesis: Profit from price MOVEMENT rather than predicting direction.
 * Enter both YES and NO at ~50¢, then exit asymmetrically:
 * - Loser exits at -10% (45¢)
 * - Winner exits at +30% (65¢)
 *
 * The profit comes from the winner's CONTINUED MOVEMENT after the loser is sold.
 */

import type {
  TradingSession,
  PriceTick,
  StrategyAction,
  DualPosition,
  DualEntryTrade,
  Side,
} from "@/types"

// Dual-Entry Strategy Configuration
export const DUAL_ENTRY_CONFIG = {
  // MAKER ORDER STRATEGY - Place limit orders at these prices
  // We place 4 orders and wait for fills on both sides
  makerBidPrice: 0.46,        // Bid YES at 46¢, Bid NO at 46¢ (aggressive)
  makerAskPrice: 0.54,        // Also bid YES at 54¢, NO at 54¢ (less aggressive)
  investmentPerSide: 100,     // $100 per side = $200 total

  // Exit thresholds - RELATIVE to entry price
  loserDropPct: 0.15,         // Exit loser when it drops 15% from entry
  winnerGainPct: 0.20,        // Exit winner when it gains 20% from entry

  // Time-based adjustments
  forceExitMinutesLeft: 1,    // Force exit if < 1 min left
  warnMinutesLeft: 3,         // Warn if < 3 min left
  minTimeToEnterMinutes: 2,   // Don't place new orders if < 2 min left (was 5)

  // Maker orders = no fees, no slippage (we set the price)
  slippageBps: 0,             // Makers don't pay slippage
  makerRebateBps: 0,          // Could add rebate simulation later

  // Fee calculation (only for taker exits)
  feeRate: 0.25,
  feeExponent: 2,
}

// Pending maker order structure
export interface MakerOrder {
  side: Side
  price: number
  shares: number
  placedAt: number
  status: 'PENDING' | 'FILLED' | 'CANCELLED'
}

// Dual-entry state with maker orders
export interface DualMakerState {
  // Pending limit orders (up to 4: YES@46, YES@54, NO@46, NO@54)
  pendingOrders: MakerOrder[]
  // Filled orders
  filledYes: MakerOrder | null
  filledNo: MakerOrder | null
}

/**
 * Calculate Polymarket fee for 15-min crypto markets
 * Fee = shares × 0.25 × (price × (1 - price))²
 */
export function calculateFee(shares: number, price: number): number {
  if (price <= 0.01 || price >= 0.99) return 0
  const fee = shares * DUAL_ENTRY_CONFIG.feeRate * Math.pow(price * (1 - price), DUAL_ENTRY_CONFIG.feeExponent)
  return Math.round(fee * 10000) / 10000 // Round to 4 decimals
}

/**
 * Apply slippage to fill price
 */
function applySlippage(price: number, action: 'BUY' | 'SELL'): number {
  const slippage = DUAL_ENTRY_CONFIG.slippageBps / 10000
  if (action === 'BUY') {
    return Math.min(0.99, price * (1 + slippage))
  } else {
    return Math.max(0.01, price * (1 - slippage))
  }
}

/**
 * Check if we should enter (buy both sides)
 */
/**
 * Check if we should place maker orders or if pending orders got filled
 *
 * MAKER STRATEGY:
 * 1. Place 4 limit orders: YES@46¢, YES@54¢, NO@46¢, NO@54¢
 * 2. Wait for market to cross our prices (fills)
 * 3. Once we have both YES and NO filled, cancel remaining orders
 * 4. Move to WAITING_LOSER state
 */
export function checkDualEntry(
  session: TradingSession,
  _tick: PriceTick
): StrategyAction | null {
  // Only process if in WAITING state
  if (session.dualEntryState !== 'WAITING') return null

  // Check if we have enough time left to enter
  const remainingMs = session.endTime - Date.now()
  const remainingMin = remainingMs / 60000
  if (remainingMin < DUAL_ENTRY_CONFIG.minTimeToEnterMinutes) {
    return null
  }

  // Initialize maker state if needed
  const makerState = session.dualMakerState || {
    pendingOrders: [],
    filledYes: null,
    filledNo: null,
  }

  // If no pending orders, place them
  if (makerState.pendingOrders.length === 0 && !makerState.filledYes && !makerState.filledNo) {
    console.log(`[DUAL MAKER] ${session.asset} | Placing 4 limit orders...`)
    return {
      type: 'ENTER',
      side: 'YES',
      reason: `Placing maker orders: YES@46¢, YES@54¢, NO@46¢, NO@54¢`,
      targetPrice: DUAL_ENTRY_CONFIG.makerBidPrice,
      targetShares: DUAL_ENTRY_CONFIG.investmentPerSide / DUAL_ENTRY_CONFIG.makerBidPrice,
      timestamp: Date.now(),
    }
  }

  return null
}

/**
 * Check if any pending maker orders should fill based on current price
 */
export function checkMakerFills(
  session: TradingSession,
  tick: PriceTick
): { filled: MakerOrder[], newState: DualMakerState } | null {
  if (!session.dualMakerState) return null

  const state = session.dualMakerState
  const filled: MakerOrder[] = []
  const stillPending: MakerOrder[] = []

  for (const order of state.pendingOrders) {
    // A BID (buy) fills when market ask price drops to or below our bid
    // YES bid fills when yesPrice <= our bid price
    // NO bid fills when noPrice <= our bid price
    const marketPrice = order.side === 'YES' ? tick.yesPrice : tick.noPrice

    if (marketPrice <= order.price) {
      // Our bid got filled!
      console.log(`[DUAL MAKER] ${session.asset} | ${order.side} bid FILLED @ ${(order.price * 100).toFixed(0)}¢ (market: ${(marketPrice * 100).toFixed(1)}¢)`)
      filled.push({ ...order, status: 'FILLED' })
    } else {
      stillPending.push(order)
    }
  }

  if (filled.length === 0) return null

  // Update state with fills
  let newFilledYes = state.filledYes
  let newFilledNo = state.filledNo

  for (const fill of filled) {
    if (fill.side === 'YES' && !newFilledYes) {
      newFilledYes = fill
    } else if (fill.side === 'NO' && !newFilledNo) {
      newFilledNo = fill
    }
  }

  // If we have both sides filled, cancel remaining orders
  if (newFilledYes && newFilledNo) {
    console.log(`[DUAL MAKER] ${session.asset} | Both sides filled! Cancelling ${stillPending.length} remaining orders`)
    stillPending.forEach(o => o.status = 'CANCELLED')
  }

  return {
    filled,
    newState: {
      pendingOrders: newFilledYes && newFilledNo ? [] : stillPending,
      filledYes: newFilledYes,
      filledNo: newFilledNo,
    }
  }
}

/**
 * Execute dual-entry - Place maker limit orders
 */
export function executeDualEntry(
  session: TradingSession,
  _tick: PriceTick
): TradingSession {
  const now = Date.now()

  // Place 4 maker orders: YES@46¢, YES@54¢, NO@46¢, NO@54¢
  const pendingOrders: MakerOrder[] = [
    {
      side: 'YES',
      price: DUAL_ENTRY_CONFIG.makerBidPrice,  // 46¢
      shares: DUAL_ENTRY_CONFIG.investmentPerSide / DUAL_ENTRY_CONFIG.makerBidPrice,
      placedAt: now,
      status: 'PENDING',
    },
    {
      side: 'YES',
      price: DUAL_ENTRY_CONFIG.makerAskPrice,  // 54¢
      shares: DUAL_ENTRY_CONFIG.investmentPerSide / DUAL_ENTRY_CONFIG.makerAskPrice,
      placedAt: now,
      status: 'PENDING',
    },
    {
      side: 'NO',
      price: DUAL_ENTRY_CONFIG.makerBidPrice,  // 46¢
      shares: DUAL_ENTRY_CONFIG.investmentPerSide / DUAL_ENTRY_CONFIG.makerBidPrice,
      placedAt: now,
      status: 'PENDING',
    },
    {
      side: 'NO',
      price: DUAL_ENTRY_CONFIG.makerAskPrice,  // 54¢
      shares: DUAL_ENTRY_CONFIG.investmentPerSide / DUAL_ENTRY_CONFIG.makerAskPrice,
      placedAt: now,
      status: 'PENDING',
    },
  ]

  console.log(`[DUAL MAKER] ${session.asset} | Placed 4 limit orders:`)
  console.log(`  YES bids: 46¢ (${pendingOrders[0].shares.toFixed(0)} shares), 54¢ (${pendingOrders[1].shares.toFixed(0)} shares)`)
  console.log(`  NO bids:  46¢ (${pendingOrders[2].shares.toFixed(0)} shares), 54¢ (${pendingOrders[3].shares.toFixed(0)} shares)`)

  const dualMakerState: DualMakerState = {
    pendingOrders,
    filledYes: null,
    filledNo: null,
  }

  // Add action for activity feed
  const newAction = {
    type: 'ENTER' as const,
    side: 'YES' as const,
    reason: `Placed 4 maker orders: YES@46¢, YES@54¢, NO@46¢, NO@54¢`,
    targetPrice: DUAL_ENTRY_CONFIG.makerBidPrice,
    targetShares: pendingOrders[0].shares,
    timestamp: now,
    fillPrice: undefined,
  }

  return {
    ...session,
    dualEntryState: 'ENTERING',  // New state: waiting for fills
    dualMakerState,
    lastActionTime: now,
    actions: [...session.actions, newAction],
  }
}

/**
 * Process maker order fills and transition to WAITING_LOSER when both sides filled
 */
export function processMakerFills(
  session: TradingSession,
  tick: PriceTick
): TradingSession {
  if (session.dualEntryState !== 'ENTERING' || !session.dualMakerState) {
    return session
  }

  const result = checkMakerFills(session, tick)
  if (!result) return session

  const { filled, newState } = result
  const now = Date.now()

  // Add fill actions to activity feed
  const fillActions = filled.map((fill, i) => ({
    type: 'ENTER' as const,
    side: fill.side,
    reason: `Maker fill: ${fill.side} @ ${(fill.price * 100).toFixed(0)}¢`,
    targetPrice: fill.price,
    targetShares: fill.shares,
    timestamp: now + i,
    fillPrice: fill.price,
  }))

  // Check if we have both sides now
  if (newState.filledYes && newState.filledNo) {
    // Both sides filled! Create position and move to WAITING_LOSER
    const yesPrice = newState.filledYes.price
    const noPrice = newState.filledNo.price
    const yesShares = newState.filledYes.shares
    const noShares = newState.filledNo.shares

    // MAKER = NO ENTRY FEES!
    const dualPosition: DualPosition = {
      yesShares,
      noShares,
      yesAvgPrice: yesPrice,
      noAvgPrice: noPrice,
      yesEntryFee: 0,  // Makers don't pay fees
      noEntryFee: 0,
      entryTime: now,
    }

    const dualTrade: DualEntryTrade = {
      loserSide: null,
      loserExitPrice: null,
      loserExitTime: null,
      loserReturn: null,
      loserExitFee: null,
      winnerSide: null,
      winnerExitPrice: null,
      winnerExitTime: null,
      winnerReturn: null,
      winnerExitFee: null,
    }

    console.log(`[DUAL MAKER] ${session.asset} | Position complete: ${yesShares.toFixed(0)} YES @ ${(yesPrice * 100).toFixed(0)}¢, ${noShares.toFixed(0)} NO @ ${(noPrice * 100).toFixed(0)}¢`)
    console.log(`[DUAL MAKER] ${session.asset} | NO ENTRY FEES (maker rebates!)`)

    return {
      ...session,
      dualEntryState: 'WAITING_LOSER',
      dualMakerState: newState,
      dualPosition,
      dualTrade,
      entryPrice: (yesPrice + noPrice) / 2,
      lastActionTime: now,
      actions: [...session.actions, ...fillActions],
    }
  }

  // Only one side filled so far, keep waiting
  return {
    ...session,
    dualMakerState: newState,
    lastActionTime: now,
    actions: [...session.actions, ...fillActions],
  }
}

/**
 * Check if loser threshold is hit
 */
export function checkLoserExit(
  session: TradingSession,
  tick: PriceTick
): { side: Side; price: number } | null {
  if (session.dualEntryState !== 'WAITING_LOSER') return null
  if (!session.dualPosition) return null

  const pos = session.dualPosition

  // Calculate loser thresholds RELATIVE to entry prices
  const yesLoserThreshold = pos.yesAvgPrice * (1 - DUAL_ENTRY_CONFIG.loserDropPct)
  const noLoserThreshold = pos.noAvgPrice * (1 - DUAL_ENTRY_CONFIG.loserDropPct)

  // Check if YES hit loser threshold (dropped 15% from entry)
  if (tick.yesPrice <= yesLoserThreshold) {
    console.log(`[DUAL] ${session.asset} | YES hit loser threshold: ${(tick.yesPrice * 100).toFixed(1)}¢ <= ${(yesLoserThreshold * 100).toFixed(1)}¢ (entry was ${(pos.yesAvgPrice * 100).toFixed(1)}¢)`)
    return { side: 'YES', price: tick.yesPrice }
  }

  // Check if NO hit loser threshold (dropped 15% from entry)
  if (tick.noPrice <= noLoserThreshold) {
    console.log(`[DUAL] ${session.asset} | NO hit loser threshold: ${(tick.noPrice * 100).toFixed(1)}¢ <= ${(noLoserThreshold * 100).toFixed(1)}¢ (entry was ${(pos.noAvgPrice * 100).toFixed(1)}¢)`)
    return { side: 'NO', price: tick.noPrice }
  }

  return null
}

/**
 * Execute loser exit
 */
export function executeLoserExit(
  session: TradingSession,
  loserSide: Side,
  exitPrice: number
): TradingSession {
  if (!session.dualPosition || !session.dualTrade) return session

  const pos = session.dualPosition
  const actualPrice = applySlippage(exitPrice, 'SELL')
  const shares = loserSide === 'YES' ? pos.yesShares : pos.noShares
  const loserReturn = shares * actualPrice
  const loserExitFee = calculateFee(shares, actualPrice)

  const winnerSide: Side = loserSide === 'YES' ? 'NO' : 'YES'

  const loserEntryPrice = loserSide === 'YES' ? pos.yesAvgPrice : pos.noAvgPrice
  const lossPct = ((loserEntryPrice - actualPrice) / loserEntryPrice * 100).toFixed(0)
  const winnerEntryPrice = winnerSide === 'YES' ? pos.yesAvgPrice : pos.noAvgPrice
  const winnerTarget = winnerEntryPrice * (1 + DUAL_ENTRY_CONFIG.winnerGainPct)

  console.log(`[DUAL LOSER] ${session.asset} | Sold ${shares.toFixed(1)} ${loserSide} @ ${(actualPrice * 100).toFixed(1)}¢ = $${loserReturn.toFixed(2)} (fee: $${loserExitFee.toFixed(2)})`)
  console.log(`[DUAL] ${session.asset} | Now waiting for ${winnerSide} to hit ${(winnerTarget * 100).toFixed(1)}¢ (+${(DUAL_ENTRY_CONFIG.winnerGainPct * 100).toFixed(0)}% from entry)`)

  const now = Date.now()
  const loserAction = {
    type: 'HEDGE' as const, // Using HEDGE type to indicate exit/sell
    side: loserSide,
    reason: `Sold loser ${loserSide} @ ${(actualPrice * 100).toFixed(1)}¢ (-${lossPct}%)`,
    targetPrice: actualPrice,
    targetShares: shares,
    timestamp: now,
    fillPrice: actualPrice,
  }

  return {
    ...session,
    dualEntryState: 'WAITING_WINNER',
    dualTrade: {
      ...session.dualTrade,
      loserSide,
      loserExitPrice: actualPrice,
      loserExitTime: now,
      loserReturn,
      loserExitFee,
      winnerSide,
    },
    lastActionTime: now,
    actions: [...session.actions, loserAction],
  }
}

/**
 * Check if winner threshold is hit
 */
export function checkWinnerExit(
  session: TradingSession,
  tick: PriceTick
): { side: Side; price: number } | null {
  if (session.dualEntryState !== 'WAITING_WINNER') return null
  if (!session.dualTrade?.winnerSide || !session.dualPosition) return null

  const pos = session.dualPosition
  const winnerSide = session.dualTrade.winnerSide
  const winnerPrice = winnerSide === 'YES' ? tick.yesPrice : tick.noPrice
  const winnerEntryPrice = winnerSide === 'YES' ? pos.yesAvgPrice : pos.noAvgPrice

  // Calculate winner threshold RELATIVE to entry price (gain 20% from entry)
  const winnerThreshold = winnerEntryPrice * (1 + DUAL_ENTRY_CONFIG.winnerGainPct)

  if (winnerPrice >= winnerThreshold) {
    console.log(`[DUAL] ${session.asset} | ${winnerSide} hit winner threshold: ${(winnerPrice * 100).toFixed(1)}¢ >= ${(winnerThreshold * 100).toFixed(1)}¢ (entry was ${(winnerEntryPrice * 100).toFixed(1)}¢)`)
    return { side: winnerSide, price: winnerPrice }
  }

  return null
}

/**
 * Execute winner exit
 */
export function executeWinnerExit(
  session: TradingSession,
  exitPrice: number
): TradingSession {
  if (!session.dualPosition || !session.dualTrade) return session

  const pos = session.dualPosition
  const trade = session.dualTrade
  const winnerSide = trade.winnerSide!
  const actualPrice = applySlippage(exitPrice, 'SELL')
  const shares = winnerSide === 'YES' ? pos.yesShares : pos.noShares
  const winnerReturn = shares * actualPrice
  const winnerExitFee = calculateFee(shares, actualPrice)

  // Calculate final P&L
  const grossReturn = (trade.loserReturn || 0) + winnerReturn
  const totalFees =
    pos.yesEntryFee +
    pos.noEntryFee +
    (trade.loserExitFee || 0) +
    winnerExitFee
  const totalInvestment = 2 * DUAL_ENTRY_CONFIG.investmentPerSide
  const profit = grossReturn - totalFees - totalInvestment

  const winnerEntryPrice = winnerSide === 'YES' ? pos.yesAvgPrice : pos.noAvgPrice
  const gainPct = ((actualPrice - winnerEntryPrice) / winnerEntryPrice * 100).toFixed(0)

  console.log(`[DUAL WINNER] ${session.asset} | Sold ${shares.toFixed(1)} ${winnerSide} @ ${(actualPrice * 100).toFixed(1)}¢ = $${winnerReturn.toFixed(2)} (fee: $${winnerExitFee.toFixed(2)})`)
  console.log(`[DUAL COMPLETE] ${session.asset} | Gross: $${grossReturn.toFixed(2)} | Fees: $${totalFees.toFixed(2)} | Profit: $${profit.toFixed(2)} (${((profit / totalInvestment) * 100).toFixed(1)}%)`)

  const now = Date.now()
  const winnerAction = {
    type: 'SCALE' as const, // Using SCALE to indicate profit-taking exit
    side: winnerSide,
    reason: `Sold winner ${winnerSide} @ ${(actualPrice * 100).toFixed(1)}¢ (+${gainPct}%) | Profit: $${profit.toFixed(2)}`,
    targetPrice: actualPrice,
    targetShares: shares,
    timestamp: now,
    fillPrice: actualPrice,
  }

  return {
    ...session,
    dualEntryState: 'CLOSED',
    state: 'CLOSED',
    dualTrade: {
      ...trade,
      winnerExitPrice: actualPrice,
      winnerExitTime: now,
      winnerReturn,
      winnerExitFee,
    },
    realizedPnl: profit,
    currentPnl: profit,
    lastActionTime: now,
    actions: [...session.actions, winnerAction],
  }
}

/**
 * Check for force exit (time running out)
 */
export function checkForceExit(
  session: TradingSession,
  _tick: PriceTick
): boolean {
  const remainingMs = session.endTime - Date.now()
  const remainingMin = remainingMs / 60000

  return remainingMin < DUAL_ENTRY_CONFIG.forceExitMinutesLeft
}

/**
 * Execute force exit (sell everything or cancel pending orders)
 */
export function executeForceExit(
  session: TradingSession,
  tick: PriceTick
): TradingSession {
  // Handle ENTERING state - cancel pending maker orders
  if (session.dualEntryState === 'ENTERING') {
    console.log(`[DUAL FORCE EXIT] ${session.asset} | Time expired - cancelling maker orders`)
    const now = Date.now()
    const cancelAction = {
      type: 'HEDGE' as const,
      side: 'YES' as const,
      reason: `Time expired: cancelled pending maker orders`,
      targetPrice: 0,
      targetShares: 0,
      timestamp: now,
      fillPrice: 0,
    }
    return {
      ...session,
      dualEntryState: 'CLOSED',
      state: 'CLOSED',
      dualMakerState: null,
      realizedPnl: 0,
      currentPnl: 0,
      lastActionTime: now,
      actions: [...session.actions, cancelAction],
    }
  }

  if (!session.dualPosition) return session

  const pos = session.dualPosition

  // If we're still waiting for loser, sell both sides
  if (session.dualEntryState === 'WAITING_LOSER') {
    const yesPrice = applySlippage(tick.yesPrice, 'SELL')
    const noPrice = applySlippage(tick.noPrice, 'SELL')
    const yesReturn = pos.yesShares * yesPrice
    const noReturn = pos.noShares * noPrice
    const yesExitFee = calculateFee(pos.yesShares, yesPrice)
    const noExitFee = calculateFee(pos.noShares, noPrice)

    const grossReturn = yesReturn + noReturn
    const totalFees = pos.yesEntryFee + pos.noEntryFee + yesExitFee + noExitFee
    const totalInvestment = 2 * DUAL_ENTRY_CONFIG.investmentPerSide
    const profit = grossReturn - totalFees - totalInvestment

    console.log(`[DUAL FORCE EXIT] ${session.asset} | Time expired - sold both sides`)
    console.log(`[DUAL FORCE EXIT] ${session.asset} | Profit: $${profit.toFixed(2)} (${((profit / totalInvestment) * 100).toFixed(1)}%)`)

    const now = Date.now()
    const forceExitActions = [
      {
        type: 'HEDGE' as const,
        side: 'YES' as const,
        reason: `Force exit: sold YES @ ${(yesPrice * 100).toFixed(1)}¢ (time expired)`,
        targetPrice: yesPrice,
        targetShares: pos.yesShares,
        timestamp: now,
        fillPrice: yesPrice,
      },
      {
        type: 'HEDGE' as const,
        side: 'NO' as const,
        reason: `Force exit: sold NO @ ${(noPrice * 100).toFixed(1)}¢ | Final P&L: $${profit.toFixed(2)}`,
        targetPrice: noPrice,
        targetShares: pos.noShares,
        timestamp: now + 1,
        fillPrice: noPrice,
      },
    ]

    return {
      ...session,
      dualEntryState: 'CLOSED',
      state: 'CLOSED',
      realizedPnl: profit,
      currentPnl: profit,
      lastActionTime: now,
      actions: [...session.actions, ...forceExitActions],
    }
  }

  // If we're waiting for winner, sell the winner at current price
  if (session.dualEntryState === 'WAITING_WINNER' && session.dualTrade?.winnerSide) {
    const winnerSide = session.dualTrade.winnerSide
    const winnerPrice = winnerSide === 'YES' ? tick.yesPrice : tick.noPrice
    console.log(`[DUAL FORCE EXIT] ${session.asset} | Time expired - selling ${winnerSide} at ${(winnerPrice * 100).toFixed(1)}¢`)
    return executeWinnerExit(session, winnerPrice)
  }

  return session
}

/**
 * Calculate current unrealized P&L for dual-entry position
 */
export function calculateDualPnl(
  session: TradingSession,
  tick: PriceTick
): number {
  if (!session.dualPosition) return session.realizedPnl

  const pos = session.dualPosition
  const trade = session.dualTrade

  if (session.dualEntryState === 'WAITING_LOSER') {
    // Both positions open - value at current prices minus entry cost and fees
    const yesValue = pos.yesShares * tick.yesPrice
    const noValue = pos.noShares * tick.noPrice
    const totalValue = yesValue + noValue
    const totalCost = (pos.yesShares * pos.yesAvgPrice) + (pos.noShares * pos.noAvgPrice)
    const entryFees = pos.yesEntryFee + pos.noEntryFee
    // Note: We haven't paid exit fees yet
    return totalValue - totalCost - entryFees
  }

  if (session.dualEntryState === 'WAITING_WINNER' && trade) {
    // Loser sold, winner still open
    const winnerSide = trade.winnerSide!
    const winnerShares = winnerSide === 'YES' ? pos.yesShares : pos.noShares
    const winnerAvgPrice = winnerSide === 'YES' ? pos.yesAvgPrice : pos.noAvgPrice
    const winnerCurrentPrice = winnerSide === 'YES' ? tick.yesPrice : tick.noPrice
    const winnerValue = winnerShares * winnerCurrentPrice
    const winnerCost = winnerShares * winnerAvgPrice

    // Already realized from loser
    const loserPnl = (trade.loserReturn || 0) - (DUAL_ENTRY_CONFIG.investmentPerSide) - pos.yesEntryFee

    // Unrealized from winner
    const winnerUnrealized = winnerValue - winnerCost

    return loserPnl + winnerUnrealized - (trade.loserExitFee || 0)
  }

  return session.realizedPnl
}
