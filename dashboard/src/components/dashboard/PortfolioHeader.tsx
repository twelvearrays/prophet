import { Badge } from "@/components/ui/badge"
import type { PortfolioStats } from "@/types"

interface PortfolioHeaderProps {
  stats: PortfolioStats
}

export function PortfolioHeader({ stats }: PortfolioHeaderProps) {
  const isProfitable = stats.dailyPnl >= 0

  return (
    <header className="flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-950/50 backdrop-blur-sm sticky top-0 z-10">
      <div className="flex items-center gap-8">
        <div>
          <p className="text-zinc-500 text-xs uppercase tracking-wide mb-1">Portfolio Value</p>
          <p className="text-2xl font-mono font-semibold tracking-tight">
            ${stats.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="h-8 w-px bg-zinc-800" />
        <div>
          <p className="text-zinc-500 text-xs uppercase tracking-wide mb-1">Today</p>
          <p className={`text-xl font-mono font-medium ${isProfitable ? "text-emerald-400" : "text-rose-400"}`}>
            {isProfitable ? "+" : ""}${stats.dailyPnl.toFixed(2)}
            <span className="text-sm ml-2 opacity-75">
              ({isProfitable ? "+" : ""}{stats.dailyPnlPercent.toFixed(2)}%)
            </span>
          </p>
        </div>
        <div className="h-8 w-px bg-zinc-800" />
        <div>
          <p className="text-zinc-500 text-xs uppercase tracking-wide mb-1">Win Rate</p>
          <p className="text-xl font-mono font-medium text-cyan-400">
            {stats.winRate.toFixed(0)}%
          </p>
        </div>
        <div className="h-8 w-px bg-zinc-800" />
        <div>
          <p className="text-zinc-500 text-xs uppercase tracking-wide mb-1">Active</p>
          <p className="text-xl font-mono font-medium">
            {stats.activeSessions}
          </p>
        </div>
      </div>
      <Badge
        variant={stats.connected ? "live" : "loss"}
        className="border"
      >
        <span className={`w-1.5 h-1.5 rounded-full mr-2 ${
          stats.connected ? "bg-cyan-400 animate-pulse" : "bg-rose-400"
        }`} />
        {stats.connected ? "Live" : "Disconnected"}
      </Badge>
    </header>
  )
}
