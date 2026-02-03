import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { TradingSession } from "@/types"

interface StrategyRecapProps {
  sessions: TradingSession[]
  strategyMode: "single" | "compare"
}

// Strategy descriptions
const MOMENTUM_DESCRIPTION = {
  name: "Momentum",
  emoji: "🚀",
  color: "emerald",
  thesis: "Ride the momentum when one side crosses 65¢",
  phases: [
    { state: "WAITING", desc: "Waiting for YES or NO to hit 65¢ (max 75¢)" },
    { state: "ENTRY", desc: "Entered position, watching for scale opportunities" },
    { state: "SCALING", desc: "Scaling up on continued momentum (+3% triggers)" },
    { state: "HEDGED", desc: "Position hedged when price dropped below adaptive threshold" },
    { state: "WATCHING", desc: "After hedge, looking for new re-entry opportunity" },
  ],
  mechanics: [
    "Entry: 50% of position when side crosses 65¢",
    "Scale 1: +30% when price rises 3% from entry",
    "Scale 2: +20% when price rises 3% from Scale 1",
    "Hedge: Buy opposite side when price drops below adaptive trigger",
    "Adaptive hedge: Uses trailing (entry-17pts) and time-decay (tightens near expiry)",
  ],
}

const DUAL_ENTRY_DESCRIPTION = {
  name: "Dual-Entry",
  emoji: "⚖️",
  color: "purple",
  thesis: "Profit from movement, not direction. Maker orders at 46¢ & 54¢.",
  phases: [
    { state: "WAITING", desc: "Ready to place maker orders" },
    { state: "ENTERING", desc: "4 limit orders placed, waiting for fills" },
    { state: "WAITING_LOSER", desc: "Both sides filled, watching for -10% loser" },
    { state: "WAITING_WINNER", desc: "Loser sold, holding for +30% winner" },
    { state: "CLOSED", desc: "Both sides exited, P&L realized" },
  ],
  mechanics: [
    "Orders: YES@46¢, YES@54¢, NO@46¢, NO@54¢",
    "Wait for fills on both YES and NO, cancel extras",
    "Loser Exit: Sell when side drops 10% from fill price",
    "Winner Exit: Sell when side gains 30% from fill price",
    "MAKER = NO FEES (0.25% rebate!)",
  ],
}

function getSessionPhaseInfo(session: TradingSession): { phase: string; detail: string } {
  if (session.strategyType === "DUAL_ENTRY") {
    switch (session.dualEntryState) {
      case "WAITING":
        return { phase: "Waiting", detail: "Ready to place maker orders" }
      case "ENTERING": {
        const makerState = session.dualMakerState
        if (makerState) {
          const pending = makerState.pendingOrders.filter(o => o.status === 'PENDING').length
          const hasYes = makerState.filledYes !== null
          const hasNo = makerState.filledNo !== null
          if (hasYes && !hasNo) {
            return { phase: "Entering", detail: `YES filled @ ${(makerState.filledYes!.price * 100).toFixed(0)}¢, waiting for NO` }
          }
          if (!hasYes && hasNo) {
            return { phase: "Entering", detail: `NO filled @ ${(makerState.filledNo!.price * 100).toFixed(0)}¢, waiting for YES` }
          }
          return { phase: "Entering", detail: `${pending} limit orders pending...` }
        }
        return { phase: "Entering", detail: "Maker orders placed" }
      }
      case "WAITING_LOSER": {
        const pos = session.dualPosition
        if (pos) {
          return { phase: "Hedged", detail: `YES@${(pos.yesAvgPrice*100).toFixed(0)}¢ NO@${(pos.noAvgPrice*100).toFixed(0)}¢ → -15% exit` }
        }
        return { phase: "Hedged", detail: `Holding both sides` }
      }
      case "WAITING_WINNER": {
        const side = session.dualTrade?.winnerSide || "?"
        return { phase: "Unhedged", detail: `${side} targeting +20% gain` }
      }
      case "CLOSED":
        return { phase: "Closed", detail: `Final P&L: $${(session.realizedPnl).toFixed(2)}` }
      default:
        return { phase: session.dualEntryState || "Unknown", detail: "" }
    }
  } else {
    // Momentum
    if (session.state === "WAITING" && session.hedgedPairs.length > 0) {
      return { phase: "Watching", detail: "Post-hedge, looking for re-entry at 65¢" }
    }
    switch (session.state) {
      case "WAITING":
        return { phase: "Waiting", detail: "Looking for YES/NO to cross 65¢" }
      case "ENTRY":
        return { phase: "Entry", detail: `${session.primaryPosition?.side} position, watching for +3% scale` }
      case "SCALING":
        return { phase: "Scaling", detail: `${session.primaryPosition?.fills.length} fills, building position` }
      case "HEDGED":
        return { phase: "Hedged", detail: "Position protected with opposite side" }
      case "CLOSED":
        return { phase: "Closed", detail: `Final P&L: $${(session.realizedPnl).toFixed(2)}` }
      default:
        return { phase: session.state, detail: "" }
    }
  }
}

export function StrategyRecap({ sessions, strategyMode }: StrategyRecapProps) {
  // Group active sessions by strategy
  const momentumSessions = sessions.filter(s => s.strategyType === "MOMENTUM" && s.state !== "CLOSED")
  const dualEntrySessions = sessions.filter(s => s.strategyType === "DUAL_ENTRY" && s.dualEntryState !== "CLOSED")

  const renderStrategySection = (
    config: typeof MOMENTUM_DESCRIPTION,
    activeSessions: TradingSession[],
    showDetails: boolean
  ) => {
    const colorClasses: Record<string, string> = {
      emerald: "text-emerald-400",
      purple: "text-purple-400",
      orange: "text-orange-400",
    }
    const bgClasses: Record<string, string> = {
      emerald: "bg-emerald-500/10 border-emerald-500/30",
      purple: "bg-purple-500/10 border-purple-500/30",
      orange: "bg-orange-500/10 border-orange-500/30",
    }
    const colorClass = colorClasses[config.color] || "text-zinc-400"
    const bgClass = bgClasses[config.color] || "bg-zinc-500/10 border-zinc-500/30"

    return (
      <div className={`p-3 rounded-lg border ${bgClass}`}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg">{config.emoji}</span>
          <span className={`font-semibold ${colorClass}`}>{config.name}</span>
          <span className="text-xs text-zinc-500">({activeSessions.length} active)</span>
        </div>

        <p className="text-xs text-zinc-400 mb-3">{config.thesis}</p>

        {showDetails && (
          <>
            {/* Phase Legend */}
            <div className="mb-3">
              <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">Phases</p>
              <div className="flex flex-wrap gap-1">
                {config.phases.map(p => (
                  <span
                    key={p.state}
                    className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700"
                    title={p.desc}
                  >
                    {p.state}
                  </span>
                ))}
              </div>
            </div>

            {/* Active Session Status */}
            {activeSessions.length > 0 && (
              <div>
                <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">Current Status</p>
                <div className="space-y-1">
                  {activeSessions.slice(0, 3).map(s => {
                    const info = getSessionPhaseInfo(s)
                    const pnl = s.currentPnl + s.realizedPnl
                    return (
                      <div key={s.id} className="flex items-center justify-between text-[10px]">
                        <span className="text-zinc-300 font-mono">{s.asset}</span>
                        <span className="text-zinc-400">{info.phase}: {info.detail}</span>
                        <span className={pnl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                          {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
                        </span>
                      </div>
                    )
                  })}
                  {activeSessions.length > 3 && (
                    <p className="text-[9px] text-zinc-500">+{activeSessions.length - 3} more...</p>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  // In compare mode, show all strategies side by side
  if (strategyMode === "compare") {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-400 uppercase tracking-wide">
            Strategy Comparison
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            {renderStrategySection(MOMENTUM_DESCRIPTION, momentumSessions, true)}
            {renderStrategySection(DUAL_ENTRY_DESCRIPTION, dualEntrySessions, true)}
          </div>
        </CardContent>
      </Card>
    )
  }

  // In single mode, just show the active strategy
  const config = momentumSessions.length > 0 ? MOMENTUM_DESCRIPTION : DUAL_ENTRY_DESCRIPTION
  const activeSessions = momentumSessions.length > 0 ? momentumSessions : dualEntrySessions

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-zinc-400 uppercase tracking-wide flex items-center gap-2">
          <span>{config.emoji}</span>
          <span>{config.name} Strategy</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {renderStrategySection(config, activeSessions, true)}
      </CardContent>
    </Card>
  )
}
