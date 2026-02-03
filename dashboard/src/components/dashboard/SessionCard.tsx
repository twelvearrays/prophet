import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ExternalLink } from "lucide-react"
import type { TradingSession } from "@/types"
import { formatPrice, formatMoney } from "@/lib/utils"

interface SessionCardProps {
  session: TradingSession
  selected?: boolean
  onClick?: () => void
  compact?: boolean // Compact mode for comparison view
}

const stateConfig: Record<string, { label: string; className: string }> = {
  // Momentum strategy states
  WAITING: { label: "Waiting", className: "border-zinc-500/30 text-zinc-400" },
  WATCHING: { label: "Watching", className: "border-purple-500/30 text-purple-400 bg-purple-500/10 animate-pulse" }, // Post-hedge re-entry
  PENDING: { label: "Pending...", className: "border-amber-500/30 text-amber-400 bg-amber-500/10 animate-pulse" },
  ENTRY: { label: "Entry", className: "border-emerald-500/30 text-emerald-400 bg-emerald-500/10" },
  SCALING: { label: "Scaling", className: "border-cyan-500/30 text-cyan-400 bg-cyan-500/10" },
  HEDGED: { label: "Hedged", className: "border-amber-500/30 text-amber-400 bg-amber-500/10" },
  CLOSED: { label: "Closed", className: "border-rose-500/30 text-rose-400 bg-rose-500/10" },
  // Dual-entry strategy states
  ENTERING: { label: "Entering", className: "border-purple-500/30 text-purple-400 bg-purple-500/10 animate-pulse" },
  WAITING_LOSER: { label: "Hedged", className: "border-purple-500/30 text-purple-400 bg-purple-500/10" },
  WAITING_WINNER: { label: "Unhedged", className: "border-amber-500/30 text-amber-400 bg-amber-500/10 animate-pulse" },
}

// YES = Green (bullish), NO = Red (bearish)
function SideBadge({ side, shares }: { side: "YES" | "NO"; shares: number }) {
  const isYes = side === "YES"
  return (
    <span className={`inline-flex items-center gap-1 font-mono ${
      isYes ? "text-emerald-400" : "text-rose-400"
    }`}>
      <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${
        isYes ? "bg-emerald-500/20 border border-emerald-500/30" : "bg-rose-500/20 border border-rose-500/30"
      }`}>
        {side}
      </span>
      <span>{shares < 1 ? shares.toFixed(1) : shares.toFixed(0)}</span>
    </span>
  )
}

export function SessionCard({ session, selected, onClick, compact }: SessionCardProps) {
  const isDualEntry = session.strategyType === 'DUAL_ENTRY'

  // Check if session is closed
  const isClosed = session.state === 'CLOSED' || session.dualEntryState === 'CLOSED'

  // For closed sessions, use realizedPnl (frozen). For active, use currentPnl + realizedPnl
  const displayPnl = isClosed
    ? session.realizedPnl
    : session.currentPnl + session.realizedPnl
  const isProfitable = displayPnl >= 0

  // Show special states based on current situation
  let displayState: string = session.state
  if (isDualEntry && session.dualEntryState) {
    // Use dual-entry state for display
    displayState = session.dualEntryState
  } else if (session.pendingOrder) {
    displayState = "PENDING"
  } else if (session.state === "WAITING" && session.hedgedPairs.length > 0) {
    displayState = "WATCHING" // Post-hedge, looking for re-entry
  }
  const config = stateConfig[displayState] || stateConfig.WAITING
  const remainingMs = session.endTime - Date.now()
  const remainingMin = Math.max(0, Math.floor(remainingMs / 60000))
  const remainingSec = Math.max(0, Math.floor((remainingMs % 60000) / 1000))
  const isExpired = remainingMs <= 0

  // Don't render expired sessions
  if (isExpired) return null

  // Compact mode for comparison view - MORE DETAILS
  if (compact) {
    // Get strategy-specific status message
    const getStatusMessage = () => {
      if (isDualEntry) {
        if (session.dualEntryState === 'WAITING') return 'Waiting for 50¢ entry'
        if (session.dualEntryState === 'ENTERING') return 'Maker orders placed...'
        if (session.dualEntryState === 'WAITING_LOSER') return `Hedged, watching for 45¢ loser`
        if (session.dualEntryState === 'WAITING_WINNER') {
          const winnerSide = session.dualTrade?.winnerSide || '?'
          return `${winnerSide} unhedged, target 65¢`
        }
        if (session.dualEntryState === 'CLOSED') return 'Closed'
        return session.dualEntryState
      } else {
        if (session.state === 'WAITING') {
          if (session.hedgedPairs.length > 0) return 'Watching for re-entry'
          return 'Waiting for 65¢ entry'
        }
        if (session.state === 'ENTRY') return `${session.primaryPosition?.side} position, scaling...`
        if (session.state === 'SCALING') return `${session.primaryPosition?.side} scaled, watching hedge`
        return session.state
      }
    }

    // Get border and badge colors based on strategy
    const getStrategyStyle = () => {
      if (isDualEntry) return { border: 'border-l-purple-500/50', badge: 'bg-purple-500/20 text-purple-400 border-purple-500/30', label: 'DUAL' }
      return { border: 'border-l-emerald-500/50', badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', label: 'MOM' }
    }
    const stratStyle = getStrategyStyle()

    return (
      <Card
        className={`cursor-pointer transition-all hover:border-zinc-700 ${
          selected ? "border-cyan-500/50 ring-1 ring-cyan-500/20" : ""
        } border-l-2 ${stratStyle.border}`}
        onClick={onClick}
      >
        <CardContent className="p-2.5 space-y-2">
          {/* Header: Strategy + State + Time */}
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-1.5">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold border ${stratStyle.badge}`}>
                {stratStyle.label}
              </span>
              <Badge variant="outline" className={`text-[9px] px-1 py-0 ${config.className}`}>
                {config.label}
              </Badge>
            </div>
            <span className="font-mono text-xs text-zinc-400">
              {remainingMin}:{remainingSec.toString().padStart(2, '0')}
            </span>
          </div>

          {/* Status message */}
          <p className="text-[10px] text-zinc-500 truncate">{getStatusMessage()}</p>

          {/* Prices row */}
          <div className="flex items-center justify-between text-xs font-mono">
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">Y:</span>
              <span className="text-emerald-400">
                {session.currentTick ? `${(session.currentTick.yesPrice * 100).toFixed(0)}¢` : '--'}
              </span>
              <span className="text-zinc-600">/</span>
              <span className="text-zinc-500">N:</span>
              <span className="text-rose-400">
                {session.currentTick ? `${(session.currentTick.noPrice * 100).toFixed(0)}¢` : '--'}
              </span>
            </div>
          </div>

          {/* Entry + Position */}
          <div className="flex items-center justify-between text-[10px]">
            <div className="text-zinc-500">
              {session.entryPrice ? (
                <span>Entry: <span className="text-white font-mono">{(session.entryPrice * 100).toFixed(0)}¢</span></span>
              ) : (
                <span>No entry yet</span>
              )}
            </div>
            {isDualEntry && session.dualPosition && (
              <span className="text-purple-400">
                Y:{session.dualPosition.yesShares.toFixed(0)}/N:{session.dualPosition.noShares.toFixed(0)}
              </span>
            )}
            {!isDualEntry && session.primaryPosition && (
              <span className={session.primaryPosition.side === 'YES' ? 'text-emerald-400' : 'text-rose-400'}>
                {session.primaryPosition.side}: {session.primaryPosition.totalShares.toFixed(0)}
              </span>
            )}
          </div>

          {/* P&L row */}
          <div className="flex items-center justify-between pt-1 border-t border-zinc-800">
            <span className="text-[10px] text-zinc-500 uppercase">
              {isClosed ? "Final P&L" : "P&L"}
            </span>
            <span className={`font-mono text-sm font-bold ${isProfitable ? "text-emerald-400" : "text-rose-400"}`}>
              {formatMoney(displayPnl)}
            </span>
          </div>

          {/* Link to market */}
          {session.slug && (
            <a
              href={`https://polymarket.com/event/${session.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[9px] text-zinc-500 hover:text-cyan-400 transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="w-2.5 h-2.5" />
              <span>View on Polymarket</span>
            </a>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card
      className={`cursor-pointer transition-all hover:border-zinc-700 ${
        selected ? "border-cyan-500/50 ring-1 ring-cyan-500/20" : ""
      }`}
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-lg font-semibold text-cyan-400">{session.asset}</span>
              <Badge variant="outline" className={config.className}>
                {config.label}
              </Badge>
              {/* Strategy indicator */}
              <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-medium ${
                isDualEntry
                  ? "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                  : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
              }`}>
                {isDualEntry ? "Dual" : "Mom"}
              </span>
            </div>
            {session.slug ? (
              <a
                href={`https://polymarket.com/event/${session.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-zinc-400 hover:text-cyan-400 truncate flex items-center gap-1 group"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="truncate">{session.marketName}</span>
                <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
              </a>
            ) : (
              <p className="text-sm text-zinc-400 truncate">{session.marketName}</p>
            )}
            {/* Live Asset Price */}
            {session.currentAssetPrice && (
              <div className="flex items-center gap-2 mt-1 text-xs font-mono">
                <span className="text-zinc-500">{session.asset}:</span>
                <span className="text-white font-medium">
                  ${session.currentAssetPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              </div>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs text-zinc-500 uppercase tracking-wide">Time Left</p>
            <p className="font-mono text-lg">
              {remainingMin}:{remainingSec.toString().padStart(2, '0')}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-zinc-500 text-xs uppercase tracking-wide">
              {session.primaryPosition ? `${session.primaryPosition.side} Price` : 'YES Price'}
            </p>
            <div className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
              <span className={`font-mono ${session.primaryPosition?.side === "NO" ? "text-rose-400" : "text-emerald-400"}`}>
                {session.currentTick
                  ? formatPrice(session.primaryPosition?.side === "NO"
                      ? session.currentTick.noPrice
                      : session.currentTick.yesPrice)
                  : '--'}
              </span>
            </div>
          </div>
          <div>
            <p className="text-zinc-500 text-xs uppercase tracking-wide">Entry</p>
            <p className="font-mono">
              {session.entryPrice ? formatPrice(session.entryPrice) : '--'}
            </p>
          </div>
          <div>
            <p className="text-zinc-500 text-xs uppercase tracking-wide">Position</p>
            {isDualEntry && session.dualPosition ? (
              <div className="flex items-center gap-1 text-xs font-mono">
                <span className="text-emerald-400">Y:{session.dualPosition.yesShares.toFixed(0)}</span>
                <span className="text-zinc-600">/</span>
                <span className="text-rose-400">N:{session.dualPosition.noShares.toFixed(0)}</span>
              </div>
            ) : session.primaryPosition ? (
              <SideBadge
                side={session.primaryPosition.side}
                shares={session.primaryPosition.totalShares}
              />
            ) : (
              <span className="font-mono text-zinc-500">--</span>
            )}
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-zinc-800">
          <div className="flex justify-between items-center">
            <span className="text-zinc-500 text-xs uppercase tracking-wide">
              {isClosed ? "Final P&L" : "Unrealized P&L"}
            </span>
            <span className={`font-mono font-medium ${isProfitable ? "text-emerald-400" : "text-rose-400"}`}>
              {formatMoney(displayPnl)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
