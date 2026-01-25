import { Card, CardContent } from "@/components/ui/card"
import { TrendingUp, TrendingDown, Minus } from "lucide-react"

interface KPIProps {
  label: string
  value: string | number
  change?: number
  prefix?: string
  suffix?: string
}

export function KPICard({ label, value, change, prefix = "", suffix = "" }: KPIProps) {
  const TrendIcon = change === undefined ? null
    : change > 0 ? TrendingUp
    : change < 0 ? TrendingDown
    : Minus

  const trendColor = change === undefined ? ""
    : change > 0 ? "text-emerald-400"
    : change < 0 ? "text-rose-400"
    : "text-zinc-500"

  return (
    <Card className="bg-zinc-900/60 border-zinc-800">
      <CardContent className="p-4">
        <p className="text-zinc-500 text-xs uppercase tracking-wide mb-2">{label}</p>
        <div className="flex items-end justify-between gap-2">
          <p className="text-2xl font-mono font-semibold tracking-tight">
            {prefix}{typeof value === "number" ? value.toLocaleString() : value}{suffix}
          </p>
          {TrendIcon && change !== undefined && (
            <div className={`flex items-center gap-1 text-sm ${trendColor}`}>
              <TrendIcon className="w-4 h-4" />
              <span className="font-mono">{change > 0 ? "+" : ""}{change.toFixed(1)}%</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
