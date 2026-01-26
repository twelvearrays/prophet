import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ExternalLink } from "lucide-react"
import { PriceChart } from "./PriceChart"
import { ActivityFeed } from "./ActivityFeed"
import type { TradingSession } from "@/types"
import { formatPrice, formatMoney } from "@/lib/utils"

interface SessionDetailProps {
  session: TradingSession | null
}

// YES = Green (bullish), NO = Red (bearish)
function SideBadge({ side, shares, size = "md" }: { side: "YES" | "NO"; shares: number; size?: "sm" | "md" | "lg" }) {
  const isYes = side === "YES"
  const sizeClasses = {
    sm: "text-xs px-1 py-0.5",
    md: "text-sm px-1.5 py-0.5",
    lg: "text-base px-2 py-1",
  }
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono ${
      isYes ? "text-emerald-400" : "text-rose-400"
    }`}>
      <span className={`rounded font-bold ${sizeClasses[size]} ${
        isYes ? "bg-emerald-500/20 border border-emerald-500/30" : "bg-rose-500/20 border border-rose-500/30"
      }`}>
        {side}
      </span>
      <span className={size === "lg" ? "text-lg" : ""}>{shares < 1 ? shares.toFixed(1) : shares.toFixed(0)}</span>
    </span>
  )
}

function SideLabel({ side }: { side: "YES" | "NO" }) {
  const isYes = side === "YES"
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-bold font-mono ${
      isYes ? "bg-emerald-500/20 border border-emerald-500/30 text-emerald-400"
            : "bg-rose-500/20 border border-rose-500/30 text-rose-400"
    }`}>
      {side}
    </span>
  )
}

export function SessionDetail({ session }: SessionDetailProps) {
  if (!session) {
    return (
      <Card className="h-full flex items-center justify-center">
        <p className="text-zinc-500">Select a session to view details</p>
      </Card>
    )
  }

  const isProfitable = session.currentPnl >= 0
  const remainingMs = session.endTime - Date.now()
  const remainingMin = Math.max(0, Math.floor(remainingMs / 60000))
  const remainingSec = Math.max(0, Math.floor((remainingMs % 60000) / 1000))

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CardTitle className="text-xl font-mono text-cyan-400">
                {session.asset}
              </CardTitle>
              <Badge variant="outline" className={`${
                session.strategyType === 'DUAL_ENTRY'
                  ? "border-purple-500/30 text-purple-400"
                  : "border-cyan-500/30 text-cyan-400"
              }`}>
                {session.strategyType === 'DUAL_ENTRY' ? session.dualEntryState : session.state}
              </Badge>
            </div>
            <div className="text-right">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">Expires</p>
              <p className="font-mono text-lg">
                {remainingMin}:{remainingSec.toString().padStart(2, '0')}
              </p>
            </div>
          </div>
          {session.slug ? (
            <a
              href={`https://polymarket.com/event/${session.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-zinc-400 hover:text-cyan-400 flex items-center gap-1 group transition-colors"
            >
              <span>{session.marketName}</span>
              <ExternalLink className="w-3.5 h-3.5 opacity-50 group-hover:opacity-100 transition-opacity" />
            </a>
          ) : (
            <p className="text-sm text-zinc-400">{session.marketName}</p>
          )}

          {/* Compact Liquidity Display */}
          {session.currentTick && (
            <div className="mt-2 flex items-center gap-4 text-xs font-mono">
              <div className="flex items-center gap-1.5">
                <span className="text-emerald-400">YES:</span>
                <span className={session.currentTick.yesLiquidity >= 50 ? "text-zinc-300" : "text-amber-400"}>
                  ${session.currentTick.yesLiquidity.toFixed(0)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-rose-400">NO:</span>
                <span className={session.currentTick.noLiquidity >= 50 ? "text-zinc-300" : "text-amber-400"}>
                  ${session.currentTick.noLiquidity.toFixed(0)}
                </span>
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent>
          <div className="h-[250px] mb-4">
            <PriceChart
              data={session.priceHistory}
              entryPrice={session.entryPrice}
              entrySide={session.primaryPosition?.side ?? null}
              threshold={0.65}
              startTime={session.startTime}
              endTime={session.endTime}
              fills={session.actions
                .filter(a => a.type !== "NONE" && a.fillPrice)
                .map(a => ({
                  timestamp: a.timestamp,
                  price: a.fillPrice!,
                  side: a.side,
                  type: a.type
                }))}
            />
          </div>

          <div className="grid grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wide">
                {session.primaryPosition ? `${session.primaryPosition.side} Price` : 'YES Price'}
              </p>
              <div className="flex items-center gap-1 mt-1">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                <span className={`font-mono text-lg ${session.primaryPosition?.side === "NO" ? "text-rose-400" : "text-emerald-400"}`}>
                  {session.currentTick
                    ? formatPrice(session.primaryPosition?.side === "NO"
                        ? session.currentTick.noPrice
                        : session.currentTick.yesPrice)
                    : '--'}
                </span>
              </div>
            </div>
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wide">Entry Price</p>
              <p className="font-mono text-lg mt-1">
                {session.entryPrice ? formatPrice(session.entryPrice) : '--'}
              </p>
            </div>
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wide">Position</p>
              <div className="mt-1">
                {session.primaryPosition ? (
                  <SideBadge
                    side={session.primaryPosition.side}
                    shares={session.primaryPosition.totalShares}
                    size="lg"
                  />
                ) : (
                  <span className="font-mono text-lg text-zinc-500">--</span>
                )}
              </div>
            </div>
            <div>
              <p className="text-zinc-500 text-xs uppercase tracking-wide">Unrealized P&L</p>
              <p className={`font-mono text-lg mt-1 ${isProfitable ? "text-emerald-400" : "text-rose-400"}`}>
                {formatMoney(session.currentPnl)}
              </p>
            </div>
          </div>

          {/* Show realized P&L from hedges if any */}
          {session.realizedPnl !== 0 && (
            <div className="mt-3 p-2 bg-zinc-800/50 rounded border border-zinc-700/50 flex justify-between items-center">
              <span className="text-xs text-zinc-400">Realized P&L (from hedges)</span>
              <span className={`font-mono text-sm ${session.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {formatMoney(session.realizedPnl)}
              </span>
            </div>
          )}

          {/* Post-hedge watching indicator */}
          {session.state === "WAITING" && session.hedgedPairs.length > 0 && !session.pendingOrder && (
            <div className="mt-3 p-3 bg-purple-500/10 rounded-lg border border-purple-500/30">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                <span className="text-purple-400 text-sm font-medium">Watching for Re-Entry</span>
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                After {session.hedgedPairs.length} hedge(s), waiting for YES or NO to cross 65¢ (max 75¢)
              </p>
            </div>
          )}

          {/* Maker Orders (Dual-Entry ENTERING state) */}
          {session.strategyType === "DUAL_ENTRY" && session.dualEntryState === "ENTERING" && session.dualMakerState && (
            <div className="mt-4 pt-4 border-t border-zinc-800">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                <p className="text-purple-400 text-xs uppercase tracking-wide">Maker Limit Orders</p>
                <span className="text-xs text-zinc-500 ml-auto">NO FEES!</span>
              </div>
              <div className="space-y-2">
                {session.dualMakerState.pendingOrders.map((order, i) => (
                  <div
                    key={i}
                    className={`flex justify-between items-center p-2 rounded border ${
                      order.status === 'FILLED'
                        ? 'bg-emerald-500/10 border-emerald-500/30'
                        : order.status === 'CANCELLED'
                        ? 'bg-zinc-800/50 border-zinc-700/50 opacity-50'
                        : 'bg-purple-500/10 border-purple-500/30'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-bold font-mono ${
                        order.side === "YES"
                          ? "bg-emerald-500/20 border border-emerald-500/30 text-emerald-400"
                          : "bg-rose-500/20 border border-rose-500/30 text-rose-400"
                      }`}>
                        {order.side}
                      </span>
                      <span className="text-zinc-300 font-mono text-sm">
                        {order.shares < 1 ? order.shares.toFixed(1) : order.shares.toFixed(0)} @ {formatPrice(order.price)}
                      </span>
                    </div>
                    <span className={`text-xs font-mono ${
                      order.status === 'FILLED' ? 'text-emerald-400' :
                      order.status === 'CANCELLED' ? 'text-zinc-500' :
                      'text-purple-400'
                    }`}>
                      {order.status}
                    </span>
                  </div>
                ))}
                {/* Show filled orders separately */}
                {session.dualMakerState.filledYes && (
                  <div className="flex justify-between items-center p-2 rounded border bg-emerald-500/10 border-emerald-500/30">
                    <div className="flex items-center gap-2">
                      <span className="px-1.5 py-0.5 rounded text-xs font-bold font-mono bg-emerald-500/20 border border-emerald-500/30 text-emerald-400">
                        YES
                      </span>
                      <span className="text-zinc-300 font-mono text-sm">
                        {session.dualMakerState.filledYes.shares < 1 ? session.dualMakerState.filledYes.shares.toFixed(1) : session.dualMakerState.filledYes.shares.toFixed(0)} @ {formatPrice(session.dualMakerState.filledYes.price)}
                      </span>
                    </div>
                    <span className="text-xs font-mono text-emerald-400">FILLED ✓</span>
                  </div>
                )}
                {session.dualMakerState.filledNo && (
                  <div className="flex justify-between items-center p-2 rounded border bg-emerald-500/10 border-emerald-500/30">
                    <div className="flex items-center gap-2">
                      <span className="px-1.5 py-0.5 rounded text-xs font-bold font-mono bg-rose-500/20 border border-rose-500/30 text-rose-400">
                        NO
                      </span>
                      <span className="text-zinc-300 font-mono text-sm">
                        {session.dualMakerState.filledNo.shares < 1 ? session.dualMakerState.filledNo.shares.toFixed(1) : session.dualMakerState.filledNo.shares.toFixed(0)} @ {formatPrice(session.dualMakerState.filledNo.price)}
                      </span>
                    </div>
                    <span className="text-xs font-mono text-emerald-400">FILLED ✓</span>
                  </div>
                )}
              </div>
              <p className="text-xs text-zinc-500 mt-2 text-center">
                Waiting for price to hit our bids...
              </p>
            </div>
          )}

          {/* Pending Order (Momentum strategy) */}
          {session.pendingOrder && (
            <div className="mt-4 pt-4 border-t border-zinc-800">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                <p className="text-amber-400 text-xs uppercase tracking-wide">Pending Order</p>
              </div>
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-1 rounded text-xs font-bold font-mono ${
                      session.pendingOrder.side === "YES"
                        ? "bg-emerald-500/20 border border-emerald-500/30 text-emerald-400"
                        : "bg-rose-500/20 border border-rose-500/30 text-rose-400"
                    }`}>
                      {session.pendingOrder.type} {session.pendingOrder.side}
                    </span>
                    <span className="text-zinc-300 font-mono text-sm">
                      @ {formatPrice(session.pendingOrder.triggerPrice)}
                    </span>
                  </div>
                  <div className="text-right">
                    <div className="flex items-center gap-1 text-amber-400 text-sm">
                      <span className="font-mono">{session.pendingOrder.confirmationTicks}/3</span>
                      <span className="text-xs text-zinc-500">ticks</span>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-zinc-400 mt-1">{session.pendingOrder.reason}</p>
              </div>
            </div>
          )}

          {session.primaryPosition && (
            <div className="mt-4 pt-4 border-t border-zinc-800">
              <p className="text-zinc-500 text-xs uppercase tracking-wide mb-2">Position Fills</p>
              <div className="space-y-1.5">
                {session.primaryPosition.fills.map((fill, i) => (
                  <div key={i} className="flex justify-between items-center text-sm font-mono">
                    <span className="flex items-center gap-2">
                      <SideLabel side={fill.side} />
                      <span className="text-zinc-300">
                        {fill.shares < 1 ? fill.shares.toFixed(1) : fill.shares.toFixed(0)} @ {formatPrice(fill.price)}
                      </span>
                    </span>
                    <span className="text-zinc-500">
                      {new Date(fill.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {session.hedgedPairs.length > 0 && (
            <div className="mt-4 pt-4 border-t border-zinc-800">
              <p className="text-amber-400 text-xs uppercase tracking-wide mb-2">⚡ Hedged Pairs</p>
              {session.hedgedPairs.map((pair, i) => (
                <div key={i} className="flex justify-between items-center text-sm font-mono bg-amber-500/5 rounded p-2 border border-amber-500/20">
                  <div className="flex items-center gap-2">
                    <SideBadge side={pair.primary.side} shares={pair.primary.totalShares} size="sm" />
                    <span className="text-amber-400">↔</span>
                    <SideBadge side={pair.hedge.side} shares={pair.hedge.totalShares} size="sm" />
                  </div>
                  <span className={pair.lockedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                    Locked: {formatMoney(pair.lockedPnl)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ActivityFeed actions={session.actions} />
    </div>
  )
}
