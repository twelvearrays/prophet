import type { StrategyAction } from "@/types"
import { formatPrice } from "@/lib/utils"

interface ActivityFeedProps {
  actions: StrategyAction[]
}

const typeConfig: Record<string, { label: string; className: string }> = {
  ENTER: { label: "ENTER", className: "text-cyan-400" },
  SCALE: { label: "SCALE", className: "text-cyan-400" },
  HEDGE: { label: "HEDGE", className: "text-amber-400" },
  CLOSE: { label: "CLOSE", className: "text-zinc-400" },
  NONE: { label: "WAIT", className: "text-zinc-500" },
}

// YES = Green, NO = Red badge
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

export function ActivityFeed({ actions }: ActivityFeedProps) {
  const filtered = actions.filter((a) => a.type !== "NONE").slice(-10).reverse()

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div className="p-3 border-b border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-300">Recent Actions</h3>
      </div>
      <div className="max-h-[200px] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-zinc-500 text-sm">
            No actions yet
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/50">
            {filtered.map((action, i) => {
              const config = typeConfig[action.type] || typeConfig.NONE
              return (
                <div key={i} className="p-3 flex items-center gap-3 text-sm">
                  <span className={`font-mono text-xs w-14 font-semibold ${config.className}`}>
                    {config.label}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-zinc-400">{action.reason}</p>
                  </div>
                  <div className="text-right flex items-center gap-2">
                    <div className="flex items-center gap-1.5 font-mono">
                      <span className="text-zinc-300">{action.targetShares.toFixed(0)}</span>
                      <SideLabel side={action.side} />
                      <span className="text-zinc-500">@</span>
                      {action.fillPrice ? (
                        <span className="flex items-center gap-1">
                          <span className="text-zinc-500 line-through text-xs">{formatPrice(action.targetPrice)}</span>
                          <span className="text-amber-400">{formatPrice(action.fillPrice)}</span>
                        </span>
                      ) : (
                        <span className="text-zinc-300">{formatPrice(action.targetPrice)}</span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-500 w-20">
                      {new Date(action.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
