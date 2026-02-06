import { useRef, useMemo } from "react"
import type { PriceTick } from "@/types"
import { formatPrice } from "@/lib/utils"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
} from "recharts"

interface PriceChartProps {
  data: PriceTick[]
  entryPrice?: number | null
  entrySide?: "YES" | "NO" | null
  threshold?: number
  startTime?: number
  endTime?: number
  fills?: Array<{ timestamp: number; price: number; side: "YES" | "NO"; type: string }>
}

const COLORS = {
  yes: "#34d399",
  no: "#fb7185",
  cyan: "#22d3ee",
  amber: "#fbbf24",
  zinc: "#71717a",
  midline: "#a1a1aa",
  grid: "#27272a",
}

function downsampleData(data: PriceTick[], maxPoints: number): PriceTick[] {
  if (data.length <= maxPoints) return data
  const result: PriceTick[] = []
  const step = (data.length - 1) / (maxPoints - 1)
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(Math.round(i * step), data.length - 1)
    result.push(data[idx])
  }
  return result
}

const MAX_RENDER_POINTS = 150

// Custom active dot (glowing current price)
function GlowDot({ cx, cy, stroke }: { cx?: number; cy?: number; stroke?: string }) {
  if (cx == null || cy == null) return null
  return (
    <g>
      <circle cx={cx} cy={cy} r={8} fill={`${stroke}4D`} />
      <circle cx={cx} cy={cy} r={5} fill={stroke} />
    </g>
  )
}

// Format timestamp for x-axis
function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

// Custom tooltip
function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ value: number; dataKey: string }> }) {
  if (!active || !payload?.length) return null
  const yes = payload.find(p => p.dataKey === "yesPrice")
  const no = payload.find(p => p.dataKey === "noPrice")
  return (
    <div className="bg-zinc-900/95 border border-zinc-700 rounded px-2.5 py-1.5 text-xs font-mono shadow-lg">
      {yes && <div style={{ color: COLORS.yes }}>YES: {formatPrice(yes.value)}</div>}
      {no && <div style={{ color: COLORS.no }}>NO: {formatPrice(no.value)}</div>}
    </div>
  )
}

// Custom Y-axis tick that shows colored badges for current prices
function PriceTick({ x, y, payload, currentYesPrice, currentNoPrice }: {
  x: number; y: number; payload: { value: number };
  currentYesPrice: number; currentNoPrice: number;
}) {
  const value = payload.value
  const label = `${Math.round(value * 100)}¢`

  // Check if this tick is near the current YES or NO price
  const isNearYes = Math.abs(value - currentYesPrice) < 0.02
  const isNearNo = Math.abs(value - currentNoPrice) < 0.02

  if (isNearYes || isNearNo) {
    // Don't render static tick if current price is nearby — the ReferenceLine label handles it
    return null
  }

  return (
    <text x={x} y={y} dy={4} textAnchor="start" fill={COLORS.zinc} fontSize={11} fontFamily="'JetBrains Mono', monospace">
      {label}
    </text>
  )
}

// Price label component for ReferenceLine
function PriceLabel({ viewBox, value, color }: { viewBox?: { x: number; y: number; width: number }; value: string; color: string }) {
  if (!viewBox) return null
  const { y, width, x } = viewBox
  return (
    <g>
      <rect x={x + width + 4} y={y - 10} width={50} height={20} rx={3} fill={color} />
      <text x={x + width + 8} y={y + 4} fill="#000" fontSize={11} fontWeight="bold" fontFamily="'JetBrains Mono', monospace">
        {value}
      </text>
    </g>
  )
}

export function PriceChart({ data, entryPrice, entrySide, threshold = 0.65, startTime: _startTime, endTime, fills = [] }: PriceChartProps) {
  // Chart-side accumulation: never let rendered data shrink
  const accumulatedRef = useRef<PriceTick[]>([])
  if (data.length >= accumulatedRef.current.length) {
    accumulatedRef.current = data
  } else if (data.length > 0) {
    const lastTick = data[data.length - 1]
    const lastAccTs = accumulatedRef.current[accumulatedRef.current.length - 1]?.timestamp || 0
    if (lastTick.timestamp > lastAccTs) {
      accumulatedRef.current = [...accumulatedRef.current, lastTick].slice(-200)
    }
  }
  const chartData = accumulatedRef.current.length > 0 ? accumulatedRef.current : data

  const currentTime = Date.now()
  const sessionEnd = endTime || (currentTime + 15 * 60 * 1000)

  const renderData = useMemo(() => downsampleData(chartData, MAX_RENDER_POINTS), [chartData])

  const currentYesPrice = chartData.length > 0 ? chartData[chartData.length - 1].yesPrice : 0
  const currentNoPrice = chartData.length > 0 ? chartData[chartData.length - 1].noPrice : 0

  if (chartData.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-zinc-500 text-sm">
        Waiting for price data...
      </div>
    )
  }

  // X-axis domain: start from first data point, end at session end
  // This ensures data always fills the left side of the chart and grows rightward
  const dataStart = chartData[0].timestamp
  const xDomainStart = dataStart
  const xDomainEnd = sessionEnd

  // Generate 4 evenly spaced time ticks
  const duration = xDomainEnd - xDomainStart
  const xTicks = [
    xDomainStart,
    xDomainStart + duration * 0.33,
    xDomainStart + duration * 0.66,
    xDomainEnd,
  ]

  return (
    <div className="w-full h-full">
      {/* Legend */}
      <div className="flex items-center gap-3 px-1 pb-1 text-[11px] font-bold" style={{ fontFamily: "'Outfit', sans-serif" }}>
        <span style={{ color: COLORS.yes }}>● YES</span>
        <span style={{ color: COLORS.no }}>● NO</span>
        <span className="font-normal" style={{ color: COLORS.amber }}>Entry: {formatPrice(threshold)}</span>
        {entryPrice && entrySide && (
          <span style={{ color: entrySide === "YES" ? COLORS.yes : COLORS.no }}>
            Pos: {entrySide} @ {formatPrice(entryPrice)}
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height="90%">
        <LineChart data={renderData} margin={{ top: 4, right: 58, bottom: 4, left: 4 }}>
          <defs>
            <linearGradient id="yesZone" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLORS.yes} stopOpacity={0.12} />
              <stop offset="100%" stopColor={COLORS.yes} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="noZone" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLORS.no} stopOpacity={0.02} />
              <stop offset="100%" stopColor={COLORS.no} stopOpacity={0.12} />
            </linearGradient>
          </defs>

          {/* Background zones */}
          <ReferenceArea y1={0.5} y2={1.0} fill="url(#yesZone)" ifOverflow="extendDomain" />
          <ReferenceArea y1={0.0} y2={0.5} fill="url(#noZone)" ifOverflow="extendDomain" />

          {/* Future area (dimmed after NOW) */}
          {currentTime < sessionEnd && (
            <ReferenceArea x1={currentTime} x2={sessionEnd} fill="rgba(39, 39, 42, 0.5)" ifOverflow="extendDomain" />
          )}

          <CartesianGrid stroke={COLORS.grid} vertical={false} />

          <XAxis
            dataKey="timestamp"
            type="number"
            domain={[xDomainStart, xDomainEnd]}
            ticks={xTicks}
            tickFormatter={formatTime}
            stroke="transparent"
            tick={{ fill: COLORS.zinc, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
            tickLine={false}
            axisLine={false}
            allowDataOverflow
          />

          <YAxis
            domain={[0, 1]}
            ticks={[0, 0.25, 0.5, 0.75, 1.0]}
            tickFormatter={(v: number) => `${Math.round(v * 100)}¢`}
            orientation="right"
            stroke="transparent"
            tick={(props: any) => (
              <PriceTick {...props} currentYesPrice={currentYesPrice} currentNoPrice={currentNoPrice} />
            )}
            tickLine={false}
            axisLine={false}
            width={50}
            allowDataOverflow
          />

          {/* 50¢ midline */}
          <ReferenceLine y={0.5} stroke={COLORS.midline} strokeWidth={1.5} strokeDasharray="8 4" />

          {/* Entry threshold */}
          <ReferenceLine y={threshold} stroke={COLORS.amber} strokeWidth={1} strokeDasharray="4 4" />

          {/* Entry price line */}
          {entryPrice && entrySide && (
            <ReferenceLine
              y={entryPrice}
              stroke={entrySide === "YES" ? COLORS.yes : COLORS.no}
              strokeWidth={2}
              strokeDasharray="6 4"
            />
          )}

          {/* Current YES price line with badge */}
          <ReferenceLine
            y={currentYesPrice}
            stroke={COLORS.yes}
            strokeWidth={0.5}
            strokeDasharray="2 3"
            label={(props: any) => <PriceLabel {...props} value={formatPrice(currentYesPrice)} color={COLORS.yes} />}
          />

          {/* Current NO price line with badge */}
          <ReferenceLine
            y={currentNoPrice}
            stroke={COLORS.no}
            strokeWidth={0.5}
            strokeDasharray="2 3"
            label={(props: any) => <PriceLabel {...props} value={formatPrice(currentNoPrice)} color={COLORS.no} />}
          />

          {/* NOW line */}
          {currentTime > xDomainStart && currentTime < sessionEnd && (
            <ReferenceLine
              x={currentTime}
              stroke={COLORS.cyan}
              strokeWidth={1}
              strokeDasharray="4 4"
              label={{ value: "NOW", position: "insideBottom", fill: COLORS.cyan, fontSize: 9, fontWeight: "bold" }}
            />
          )}

          <Tooltip content={<ChartTooltip />} />

          {/* YES price line */}
          <Line
            type="monotone"
            dataKey="yesPrice"
            stroke={COLORS.yes}
            strokeWidth={2.5}
            dot={false}
            activeDot={<GlowDot />}
            isAnimationActive={false}
          />

          {/* NO price line */}
          <Line
            type="monotone"
            dataKey="noPrice"
            stroke={COLORS.no}
            strokeWidth={2.5}
            dot={false}
            activeDot={<GlowDot />}
            isAnimationActive={false}
          />

          {/* Fill markers */}
          {fills.map((fill, i) => (
            <ReferenceLine
              key={`fill-${i}`}
              x={fill.timestamp}
              stroke="transparent"
              ifOverflow="extendDomain"
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
