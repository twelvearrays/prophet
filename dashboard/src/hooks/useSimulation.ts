import { useState, useEffect, useCallback, useRef } from "react"
import type { TradingSession, PriceTick, PortfolioStats, StrategyAction, Position, Fill } from "@/types"

// Strategy configuration
const CONFIG = {
  positionSize: 30,
  entryThreshold: 0.65,
  scale2Threshold: 0.73,
  scale3Threshold: 0.80,
  hedgeDropPoints: 0.12,
  lateGameMinutes: 3,
  lateGameThreshold: 0.85,
}

// Simulation parameters
const SIM_CONFIG = {
  volatility: 0.025,
  momentumFactor: 0.55,
  meanReversionFactor: 0.03,
  driftStrength: 0.01,
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function generateNextPrice(
  currentPrice: number,
  momentum: number,
  endTime: number
): { price: number; momentum: number } {
  const remainingMs = endTime - Date.now()
  const remainingRatio = Math.max(0, Math.min(1, remainingMs / (15 * 60 * 1000)))

  // Random shock
  const shock = (Math.random() - 0.5) * 2 * SIM_CONFIG.volatility

  // Momentum continuation
  const momentumComponent = momentum * SIM_CONFIG.momentumFactor

  // Mean reversion toward 0.5
  const meanReversionComponent = (0.5 - currentPrice) * SIM_CONFIG.meanReversionFactor

  // Drift toward extremes as time runs out
  const driftTarget = currentPrice > 0.5 ? 1 : 0
  const driftComponent = (driftTarget - currentPrice) * SIM_CONFIG.driftStrength * (1 - remainingRatio)

  const priceChange = shock + momentumComponent + meanReversionComponent + driftComponent
  const newPrice = clamp(currentPrice + priceChange, 0.02, 0.98)
  const newMomentum = priceChange * 0.6 + momentum * 0.4

  return { price: newPrice, momentum: newMomentum }
}

function createSession(id: string, asset: string): TradingSession {
  const now = Date.now()
  const endTime = now + 15 * 60 * 1000 // 15 minutes

  return {
    id,
    marketId: `${asset}-updown-15m-${Math.floor(now / 900000) * 900}`,
    marketName: `Will ${asset} price be higher in 15 minutes?`,
    asset,
    state: "WAITING",
    startTime: now,
    endTime,
    primaryPosition: null,
    hedgedPairs: [],
    priceHistory: [],
    currentTick: null,
    entryPrice: null,
    currentPnl: 0,
    realizedPnl: 0,
    actions: [],
    strategyType: "MOMENTUM", // Simulation only supports momentum for now
  }
}

export function useSimulation() {
  const [sessions, setSessions] = useState<TradingSession[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [stats, setStats] = useState<PortfolioStats>({
    totalValue: 1000,
    dailyPnl: 0,
    dailyPnlPercent: 0,
    totalTrades: 0,
    winRate: 50,
    activeSessions: 0,
    connected: true,
  })

  const momentumRef = useRef<Map<string, number>>(new Map())
  const intervalRef = useRef<number | null>(null)

  // Initialize sessions
  useEffect(() => {
    const assets = ["BTC", "ETH", "SOL"]
    const newSessions = assets.map((asset, i) =>
      createSession(`session-${i}`, asset)
    )
    setSessions(newSessions)
    setSelectedSessionId(newSessions[0]?.id || null)

    // Initialize momentum
    assets.forEach((_, i) => {
      momentumRef.current.set(`session-${i}`, 0)
    })
  }, [])

  // Strategy evaluation
  const evaluateStrategy = useCallback(
    (session: TradingSession, tick: PriceTick): StrategyAction | null => {
      const remainingMs = session.endTime - Date.now()
      const remainingMin = remainingMs / 60000
      const isLateGame = remainingMin < CONFIG.lateGameMinutes
      const threshold = isLateGame ? CONFIG.lateGameThreshold : CONFIG.entryThreshold

      // Determine which side has conviction
      const yesPrice = tick.yesPrice
      const noPrice = tick.noPrice

      if (session.state === "WAITING") {
        // Check for entry
        if (yesPrice >= threshold) {
          return {
            type: "ENTER",
            side: "YES",
            reason: `YES crossed ${(threshold * 100).toFixed(0)}¢ threshold`,
            targetPrice: yesPrice,
            targetShares: (CONFIG.positionSize * 0.5) / yesPrice,
            timestamp: Date.now(),
          }
        }
        if (noPrice >= threshold) {
          return {
            type: "ENTER",
            side: "NO",
            reason: `NO crossed ${(threshold * 100).toFixed(0)}¢ threshold`,
            targetPrice: noPrice,
            targetShares: (CONFIG.positionSize * 0.5) / noPrice,
            timestamp: Date.now(),
          }
        }
        return null
      }

      if (session.state === "ENTRY" && session.primaryPosition) {
        const pos = session.primaryPosition
        const currentPrice = pos.side === "YES" ? yesPrice : noPrice
        const oppPrice = pos.side === "YES" ? noPrice : yesPrice

        // Check for hedge (price dropped)
        if (session.entryPrice && currentPrice < session.entryPrice - CONFIG.hedgeDropPoints) {
          return {
            type: "HEDGE",
            side: pos.side === "YES" ? "NO" : "YES",
            reason: `Price dropped ${CONFIG.hedgeDropPoints * 100}pts from entry`,
            targetPrice: oppPrice,
            targetShares: pos.totalShares,
            timestamp: Date.now(),
          }
        }

        // Check for scale
        if (currentPrice >= CONFIG.scale2Threshold && pos.fills.length === 1) {
          return {
            type: "SCALE",
            side: pos.side,
            reason: `Price reached ${(CONFIG.scale2Threshold * 100).toFixed(0)}¢ - adding 30%`,
            targetPrice: currentPrice,
            targetShares: (CONFIG.positionSize * 0.3) / currentPrice,
            timestamp: Date.now(),
          }
        }
        if (currentPrice >= CONFIG.scale3Threshold && pos.fills.length === 2) {
          return {
            type: "SCALE",
            side: pos.side,
            reason: `Price reached ${(CONFIG.scale3Threshold * 100).toFixed(0)}¢ - adding final 20%`,
            targetPrice: currentPrice,
            targetShares: (CONFIG.positionSize * 0.2) / currentPrice,
            timestamp: Date.now(),
          }
        }
      }

      return null
    },
    []
  )

  // Execute action
  const executeAction = useCallback(
    (session: TradingSession, action: StrategyAction): TradingSession => {
      const updated = { ...session }
      updated.actions = [...updated.actions, action]

      if (action.type === "ENTER") {
        const fill: Fill = {
          side: action.side,
          price: action.targetPrice,
          shares: action.targetShares,
          timestamp: action.timestamp,
        }
        updated.primaryPosition = {
          side: action.side,
          fills: [fill],
          totalShares: action.targetShares,
          avgPrice: action.targetPrice,
          currentPrice: action.targetPrice,
        }
        updated.entryPrice = action.targetPrice
        updated.state = "ENTRY"
      }

      if (action.type === "SCALE" && updated.primaryPosition) {
        const fill: Fill = {
          side: action.side,
          price: action.targetPrice,
          shares: action.targetShares,
          timestamp: action.timestamp,
        }
        const pos = updated.primaryPosition
        const newTotalShares = pos.totalShares + action.targetShares
        const newAvgPrice =
          (pos.avgPrice * pos.totalShares + action.targetPrice * action.targetShares) /
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
          price: action.targetPrice,
          shares: action.targetShares,
          timestamp: action.timestamp,
        }
        const hedgePosition: Position = {
          side: action.side,
          fills: [hedgeFill],
          totalShares: action.targetShares,
          avgPrice: action.targetPrice,
          currentPrice: action.targetPrice,
        }

        const lockedPnl =
          -updated.primaryPosition.avgPrice * updated.primaryPosition.totalShares -
          action.targetPrice * action.targetShares +
          updated.primaryPosition.totalShares // One side wins $1

        updated.hedgedPairs = [
          ...updated.hedgedPairs,
          {
            primary: { ...updated.primaryPosition },
            hedge: hedgePosition,
            lockedPnl,
          },
        ]
        updated.primaryPosition = null
        updated.state = "HEDGED"
      }

      return updated
    },
    []
  )

  // Update P&L
  const updatePnl = useCallback((session: TradingSession, tick: PriceTick): TradingSession => {
    let pnl = 0

    if (session.primaryPosition) {
      const pos = session.primaryPosition
      const currentPrice = pos.side === "YES" ? tick.yesPrice : tick.noPrice
      const cost = pos.avgPrice * pos.totalShares
      const value = currentPrice * pos.totalShares
      pnl = value - cost
    }

    for (const pair of session.hedgedPairs) {
      pnl += pair.lockedPnl
    }

    return { ...session, currentPnl: pnl }
  }, [])

  // Main simulation tick
  useEffect(() => {
    if (sessions.length === 0) return

    intervalRef.current = window.setInterval(() => {
      setSessions((prev) => {
        const updated = prev.map((session) => {
          // Check if session expired
          if (Date.now() >= session.endTime) {
            if (session.state !== "CLOSED") {
              return { ...session, state: "CLOSED" as const }
            }
            return session
          }

          // Generate price
          const momentum = momentumRef.current.get(session.id) || 0
          const lastPrice = session.currentTick?.yesPrice || 0.5
          const { price: newPrice, momentum: newMomentum } = generateNextPrice(
            lastPrice,
            momentum,
            session.endTime
          )
          momentumRef.current.set(session.id, newMomentum)

          const tick: PriceTick = {
            timestamp: Date.now(),
            yesPrice: newPrice,
            noPrice: 1 - newPrice,
            yesLiquidity: 100,
            noLiquidity: 100,
          }

          let updatedSession: TradingSession = {
            ...session,
            currentTick: tick,
            priceHistory: [...session.priceHistory.slice(-100), tick],
          }

          // Update position current price
          if (updatedSession.primaryPosition) {
            const pos = updatedSession.primaryPosition
            updatedSession.primaryPosition = {
              ...pos,
              currentPrice: pos.side === "YES" ? tick.yesPrice : tick.noPrice,
            }
          }

          // Evaluate strategy
          const action = evaluateStrategy(updatedSession, tick)
          if (action) {
            updatedSession = executeAction(updatedSession, action)
          }

          // Update P&L
          updatedSession = updatePnl(updatedSession, tick)

          return updatedSession
        })

        return updated
      })

      // Update stats
      setSessions((current) => {
        const totalPnl = current.reduce((sum, s) => sum + s.currentPnl + s.realizedPnl, 0)
        const activeSessions = current.filter((s) => s.state !== "CLOSED").length
        const totalTrades = current.reduce((sum, s) => sum + s.actions.filter((a) => a.type !== "NONE").length, 0)

        setStats((prev) => ({
          ...prev,
          dailyPnl: totalPnl,
          dailyPnlPercent: (totalPnl / prev.totalValue) * 100,
          activeSessions,
          totalTrades,
        }))

        return current
      })
    }, 1000)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [sessions.length, evaluateStrategy, executeAction, updatePnl])

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) || null

  return {
    sessions,
    selectedSession,
    selectedSessionId,
    setSelectedSessionId,
    stats,
  }
}
