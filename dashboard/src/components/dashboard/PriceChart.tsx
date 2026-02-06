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

// Custom dot for fill markers (triangles)
function FillMarker({ cx, cy, fill: fillData }: { cx: number; cy: number; fill: { side: "YES" | "NO"; type: string } }) {
  const color = fillData.side === "YES" ? COLORS.yes : COLORS.no
  return (
    <g>
      <polygon
        points={`${cx},${cy - 8} ${cx - 6},${cy + 4} ${cx + 6},${cy + 4}`}
        fill={color}
        stroke="#000"
        strokeWidth={1}
      />
      {fillData.type === "HEDGE" && (
        <text x={cx} y={cy - 12} textAnchor="middle" fill={COLORS.amber} fontSize={8} fontWeight="bold" fontFamily="'Outfit', sans-serif">
          H
        </text>
      )}
    </g>
  )
}

// Custom active dot (glowing current price)
function GlowDot({ cx, cy, stroke }: { cx?: number; cy?: number; stroke?: string }) {
  if (cx == null || cy == null) return null
  return (
    <g>
      <circle cx={cx} cy={cy} r={10} fill={`${stroke}4D`} />
      <circle cx={cx} cy={cy} r={6} fill={stroke} />
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

export function PriceChart({ data, entryPrice, entrySide, threshold = 0.65, startTime, endTime, fills = [] }: PriceChartProps) {
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
  const sessionStart = startTime || (chartData[0]?.timestamp || currentTime)
  const sessionEnd = endTime || (sessionStart + 15 * 60 * 1000)

  // Build render data with downsampling
  const renderData = useMemo(() => downsampleData(chartData, MAX_RENDER_POINTS), [chartData])

  // Current prices for the legend
  const currentYesPrice = chartData.length > 0 ? chartData[chartData.length - 1].yesPrice : 0
  const currentNoPrice = chartData.length > 0 ? chartData[chartData.length - 1].noPrice : 0

  if (chartData.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-zinc-500 font-outfit text-sm">
        Waiting for price data...
      </div>
    )
  }

  // X-axis ticks: start, mid, end
  const midTime = sessionStart + (sessionEnd - sessionStart) / 2
  const xTicks = [sessionStart, midTime, sessionEnd]

  return (
    <div className="w-full h-full relative">
      {/* Legend bar */}
      <div className="absolute top-0 left-2 z-10 flex items-center gap-4 text-[11px] font-bold" style={{ fontFamily: "'Outfit', sans-serif" }}>
        <span style={{ color: COLORS.yes }}>● YES</span>
        <span style={{ color: COLORS.no }}>● NO</span>
        <span className="font-normal" style={{ color: COLORS.amber }}>Entry: {formatPrice(threshold)}</span>
        {entryPrice && entrySide && (
          <span style={{ color: entrySide === "YES" ? COLORS.yes : COLORS.no }}>
            Position: {entrySide} @ {formatPrice(entryPrice)}
          </span>
        )}
      </div>

      {/* Zone labels */}
      <div className="absolute top-[30px] right-[65px] z-10 text-[11px] font-bold opacity-70" style={{ color: COLORS.yes, fontFamily: "'Outfit', sans-serif" }}>
        ▲ UP wins
      </div>
      <div className="absolute bottom-[28px] right-[65px] z-10 text-[11px] font-bold opacity-70" style={{ color: COLORS.no, fontFamily: "'Outfit', sans-serif" }}>
        ▼ DOWN wins
      </div>

      {/* Current price badges */}
      <div className="absolute right-1 z-10 flex flex-col gap-1" style={{ top: "30px" }}>
        <div className="rounded px-1.5 py-0.5 text-[11px] font-bold font-mono text-black" style={{ backgroundColor: COLORS.yes }}>
          {formatPrice(currentYesPrice)}
        </div>
        <div className="rounded px-1.5 py-0.5 text-[11px] font-bold font-mono text-black" style={{ backgroundColor: COLORS.no }}>
          {formatPrice(currentNoPrice)}
        </div>
      </div>

      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={renderData} margin={{ top: 28, right: 60, bottom: 20, left: 8 }}>
          {/* Background zones via ReferenceArea */}
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

          <ReferenceArea y1={0.5} y2={1.0} fill="url(#yesZone)" />
          <ReferenceArea y1={0.0} y2={0.5} fill="url(#noZone)" />

          {/* Future area (after NOW) */}
          {currentTime < sessionEnd && (
            <ReferenceArea x1={currentTime} x2={sessionEnd} fill="rgba(39, 39, 42, 0.5)" />
          )}

          <CartesianGrid stroke={COLORS.grid} strokeDasharray="" vertical={false} />

          <XAxis
            dataKey="timestamp"
            type="number"
            domain={[sessionStart, sessionEnd]}
            ticks={xTicks}
            tickFormatter={formatTime}
            stroke="transparent"
            tick={{ fill: COLORS.zinc, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
            tickLine={false}
          />

          <YAxis
            domain={[0, 1]}
            ticks={[0, 0.25, 0.5, 0.75, 1.0]}
            tickFormatter={(v: number) => `${Math.round(v * 100)}¢`}
            orientation="right"
            stroke="transparent"
            tick={{ fill: COLORS.zinc, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}
            tickLine={false}
            width={55}
          />

          {/* 50¢ midline */}
          <ReferenceLine y={0.5} stroke={COLORS.midline} strokeWidth={2} strokeDasharray="8 4" />

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

          {/* NOW line */}
          {currentTime > sessionStart && currentTime < sessionEnd && (
            <ReferenceLine
              x={currentTime}
              stroke={COLORS.cyan}
              strokeWidth={1}
              strokeDasharray="4 4"
              label={{ value: "NOW", position: "insideBottomLeft", fill: COLORS.cyan, fontSize: 9, fontWeight: "bold" }}
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

          {/* Fill markers as reference dots */}
          {fills.map((fill, i) => (
            <ReferenceLine
              key={i}
              x={fill.timestamp}
              stroke="transparent"
              label={({ viewBox }: { viewBox: { x: number; y: number } }) => {
                // Calculate y position from price
                const chartHeight = 250 - 28 - 20 // approx from margins
                const cy = 28 + (1 - fill.price) * chartHeight
                return <FillMarker cx={viewBox.x} cy={cy} fill={fill} />
              }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
