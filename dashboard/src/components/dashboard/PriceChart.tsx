import { useEffect, useRef, useState, useMemo } from "react"
import type { PriceTick } from "@/types"
import { formatPrice } from "@/lib/utils"

interface PriceChartProps {
  data: PriceTick[]
  entryPrice?: number | null
  entrySide?: "YES" | "NO" | null
  threshold?: number
  startTime?: number // Session start time
  endTime?: number   // Session end time
  fills?: Array<{ timestamp: number; price: number; side: "YES" | "NO"; type: string }> // Show fill markers
}

// Downsample data to max N points (keeps first, last, and evenly spaced middle points)
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

// Colors
const COLORS = {
  yes: "#34d399",      // emerald-400 (UP/YES winning)
  yesBg: "rgba(52, 211, 153, 0.2)",
  no: "#fb7185",       // rose-400 (DOWN/NO winning)
  noBg: "rgba(251, 113, 133, 0.2)",
  cyan: "#22d3ee",     // cyan-400
  amber: "#fbbf24",    // amber-400
  zinc: "#71717a",
  zincDark: "#52525b",
  grid: "#27272a",
  midline: "#a1a1aa",
}

// Max points to render (100 is plenty for visual fidelity on any screen)
const MAX_RENDER_POINTS = 100
// Throttle renders to ~10fps (every 100ms)
const RENDER_THROTTLE_MS = 100

export function PriceChart({ data, entryPrice, entrySide, threshold = 0.65, startTime, endTime, fills = [] }: PriceChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const lastRenderTimeRef = useRef<number>(0)
  const pendingRenderRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Downsample data for rendering - memoized to avoid recalculation
  const renderData = useMemo(() => downsampleData(data, MAX_RENDER_POINTS), [data])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
      }
    })

    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  // Main render effect with throttling
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || dimensions.width === 0) return

    // Throttle: skip if we rendered too recently
    const now = Date.now()
    const timeSinceLastRender = now - lastRenderTimeRef.current

    if (timeSinceLastRender < RENDER_THROTTLE_MS) {
      // Schedule a render for later if not already scheduled
      if (!pendingRenderRef.current) {
        pendingRenderRef.current = setTimeout(() => {
          pendingRenderRef.current = null
          // Force a re-render by updating a dummy state would be complex,
          // so we just render directly here
          doRender()
        }, RENDER_THROTTLE_MS - timeSinceLastRender)
      }
      return
    }

    lastRenderTimeRef.current = now
    doRender()

    function doRender() {
      const ctx = canvas!.getContext("2d")
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      canvas!.width = dimensions.width * dpr
      canvas!.height = dimensions.height * dpr
      ctx.scale(dpr, dpr)

      const padding = { top: 30, right: 60, bottom: 25, left: 10 }
      const chartWidth = dimensions.width - padding.left - padding.right
      const chartHeight = dimensions.height - padding.top - padding.bottom

      // Clear
      ctx.fillStyle = "transparent"
      ctx.fillRect(0, 0, dimensions.width, dimensions.height)

      if (data.length === 0) {
        ctx.fillStyle = "#71717a"
        ctx.font = "14px 'Outfit', sans-serif"
        ctx.textAlign = "center"
        ctx.fillText("Waiting for price data...", dimensions.width / 2, dimensions.height / 2)
        return
      }

      // Fixed price range: 0¢ to 100¢
      const toY = (price: number) => padding.top + (1 - price) * chartHeight

      // Time-based X axis - show full 15-minute window
      const currentTime = Date.now()
      const sessionStart = startTime || (data[0]?.timestamp || currentTime)
      const sessionEnd = endTime || (sessionStart + 15 * 60 * 1000)
      const sessionDuration = sessionEnd - sessionStart

      const toX = (timestamp: number) => {
        const elapsed = timestamp - sessionStart
        const progress = Math.max(0, Math.min(1, elapsed / sessionDuration))
        return padding.left + progress * chartWidth
      }

      const midY = toY(0.5)
      const nowX = toX(currentTime) // Current time position

      // Background zones
      // TOP = YES/UP winning (green tint)
      const yesGradient = ctx.createLinearGradient(0, padding.top, 0, midY)
      yesGradient.addColorStop(0, "rgba(52, 211, 153, 0.12)")
      yesGradient.addColorStop(1, "rgba(52, 211, 153, 0.02)")
      ctx.fillStyle = yesGradient
      ctx.fillRect(padding.left, padding.top, chartWidth, midY - padding.top)

      // BOTTOM = NO/DOWN winning (red tint)
      const noGradient = ctx.createLinearGradient(0, midY, 0, dimensions.height - padding.bottom)
      noGradient.addColorStop(0, "rgba(251, 113, 133, 0.02)")
      noGradient.addColorStop(1, "rgba(251, 113, 133, 0.12)")
      ctx.fillStyle = noGradient
      ctx.fillRect(padding.left, midY, chartWidth, dimensions.height - padding.bottom - midY)

      // Grid lines
      const gridLevels = [0, 0.25, 0.5, 0.75, 1.0]
      ctx.strokeStyle = COLORS.grid
      ctx.lineWidth = 1
      for (const price of gridLevels) {
        const y = toY(price)
        ctx.beginPath()
        ctx.moveTo(padding.left, y)
        ctx.lineTo(dimensions.width - padding.right, y)
        ctx.stroke()
      }

      // 50¢ center line (prominent - this is the key level!)
      ctx.strokeStyle = COLORS.midline
      ctx.lineWidth = 2
      ctx.setLineDash([8, 4])
      ctx.beginPath()
      ctx.moveTo(padding.left, midY)
      ctx.lineTo(dimensions.width - padding.right, midY)
      ctx.stroke()
      ctx.setLineDash([])

      // Entry threshold line
      const thresholdY = toY(threshold)
      ctx.strokeStyle = COLORS.amber
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(padding.left, thresholdY)
      ctx.lineTo(dimensions.width - padding.right, thresholdY)
      ctx.stroke()
      ctx.setLineDash([])

      // Get current prices from original data (not downsampled)
      const currentYesPrice = data[data.length - 1].yesPrice
      const currentNoPrice = data[data.length - 1].noPrice

      // Entry price line (if we have a position)
      if (entryPrice && entrySide) {
        const entryY = toY(entryPrice)
        const entryColor = entrySide === "YES" ? COLORS.yes : COLORS.no
        ctx.strokeStyle = entryColor
        ctx.lineWidth = 2
        ctx.setLineDash([6, 4])
        ctx.beginPath()
        ctx.moveTo(padding.left, entryY)
        ctx.lineTo(dimensions.width - padding.right, entryY)
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Draw "future" area (where time hasn't reached yet) with subtle pattern
      if (nowX < dimensions.width - padding.right) {
        ctx.fillStyle = "rgba(39, 39, 42, 0.5)"
        ctx.fillRect(nowX, padding.top, dimensions.width - padding.right - nowX, chartHeight)

        // Vertical line at current time
        ctx.strokeStyle = COLORS.cyan
        ctx.lineWidth = 1
        ctx.setLineDash([4, 4])
        ctx.beginPath()
        ctx.moveTo(nowX, padding.top)
        ctx.lineTo(nowX, dimensions.height - padding.bottom)
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Draw YES price line (green) - uses downsampled data
      if (renderData.length > 1) {
        ctx.beginPath()
        ctx.moveTo(toX(renderData[0].timestamp), toY(renderData[0].yesPrice))
        for (let i = 1; i < renderData.length; i++) {
          ctx.lineTo(toX(renderData[i].timestamp), toY(renderData[i].yesPrice))
        }
        ctx.strokeStyle = COLORS.yes
        ctx.lineWidth = 2.5
        ctx.stroke()
      }

      // Draw NO price line (red) - uses downsampled data
      if (renderData.length > 1) {
        ctx.beginPath()
        ctx.moveTo(toX(renderData[0].timestamp), toY(renderData[0].noPrice))
        for (let i = 1; i < renderData.length; i++) {
          ctx.lineTo(toX(renderData[i].timestamp), toY(renderData[i].noPrice))
        }
        ctx.strokeStyle = COLORS.no
        ctx.lineWidth = 2.5
        ctx.stroke()
      }

      // Draw dots at key points - use renderData (already downsampled)
      if (renderData.length > 0) {
        const step = Math.max(1, Math.floor(renderData.length / 20))
        // YES dots
        ctx.fillStyle = COLORS.yes
        for (let i = 0; i < renderData.length; i += step) {
          const x = toX(renderData[i].timestamp)
          const y = toY(renderData[i].yesPrice)
          ctx.beginPath()
          ctx.arc(x, y, 2.5, 0, Math.PI * 2)
          ctx.fill()
        }
        // NO dots
        ctx.fillStyle = COLORS.no
        for (let i = 0; i < renderData.length; i += step) {
          const x = toX(renderData[i].timestamp)
          const y = toY(renderData[i].noPrice)
          ctx.beginPath()
          ctx.arc(x, y, 2.5, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // Draw fill markers (triangles for buy points)
      for (const fill of fills) {
        const fillX = toX(fill.timestamp)
        const fillY = toY(fill.price)
        const fillColor = fill.side === "YES" ? COLORS.yes : COLORS.no

        // Triangle pointing up for buys
        ctx.beginPath()
        ctx.moveTo(fillX, fillY - 8)
        ctx.lineTo(fillX - 6, fillY + 4)
        ctx.lineTo(fillX + 6, fillY + 4)
        ctx.closePath()
        ctx.fillStyle = fillColor
        ctx.fill()

        // Border
        ctx.strokeStyle = "#000"
        ctx.lineWidth = 1
        ctx.stroke()

        // Label for type
        if (fill.type === "HEDGE") {
          ctx.fillStyle = COLORS.amber
          ctx.font = "bold 8px 'Outfit', sans-serif"
          ctx.textAlign = "center"
          ctx.fillText("H", fillX, fillY - 12)
        }
      }

      // Current price dots - use original data for accurate current price
      const lastTick = data[data.length - 1]
      const lastX = toX(lastTick.timestamp)
      const lastYesY = toY(currentYesPrice)
      const lastNoY = toY(currentNoPrice)

      // YES glow and dot
      ctx.beginPath()
      ctx.arc(lastX, lastYesY, 10, 0, Math.PI * 2)
      ctx.fillStyle = COLORS.yes + "4D"
      ctx.fill()
      ctx.beginPath()
      ctx.arc(lastX, lastYesY, 6, 0, Math.PI * 2)
      ctx.fillStyle = COLORS.yes
      ctx.fill()

      // NO glow and dot
      ctx.beginPath()
      ctx.arc(lastX, lastNoY, 10, 0, Math.PI * 2)
      ctx.fillStyle = COLORS.no + "4D"
      ctx.fill()
      ctx.beginPath()
      ctx.arc(lastX, lastNoY, 6, 0, Math.PI * 2)
      ctx.fillStyle = COLORS.no
      ctx.fill()

      // Y-axis labels
      ctx.font = "11px 'JetBrains Mono', monospace"
      ctx.textAlign = "left"

      const labels = [
        { price: 1.0, label: "100¢", color: COLORS.yes },
        { price: 0.75, label: "75¢", color: COLORS.zinc },
        { price: 0.5, label: "50¢", color: COLORS.midline },
        { price: 0.25, label: "25¢", color: COLORS.zinc },
        { price: 0, label: "0¢", color: COLORS.no },
      ]

      for (const { price, label, color } of labels) {
        const y = toY(price)
        ctx.fillStyle = color
        ctx.fillText(label, dimensions.width - padding.right + 8, y + 4)
      }

      // YES price label box
      const yesLabel = formatPrice(currentYesPrice)
      ctx.fillStyle = COLORS.yes
      ctx.beginPath()
      ctx.roundRect(dimensions.width - padding.right + 4, lastYesY - 12, 52, 20, 4)
      ctx.fill()
      ctx.fillStyle = "#000"
      ctx.font = "bold 11px 'JetBrains Mono', monospace"
      ctx.textAlign = "left"
      ctx.fillText(yesLabel, dimensions.width - padding.right + 8, lastYesY + 3)

      // NO price label box
      const noLabel = formatPrice(currentNoPrice)
      ctx.fillStyle = COLORS.no
      ctx.beginPath()
      ctx.roundRect(dimensions.width - padding.right + 4, lastNoY - 12, 52, 20, 4)
      ctx.fill()
      ctx.fillStyle = "#000"
      ctx.font = "bold 11px 'JetBrains Mono', monospace"
      ctx.textAlign = "left"
      ctx.fillText(noLabel, dimensions.width - padding.right + 8, lastNoY + 3)

      // Legend at top - show YES and NO labels
      ctx.font = "bold 11px 'Outfit', sans-serif"
      ctx.textAlign = "left"

      // YES legend
      ctx.fillStyle = COLORS.yes
      ctx.fillText("● YES", padding.left, 14)

      // NO legend
      ctx.fillStyle = COLORS.no
      ctx.fillText("● NO", padding.left + 55, 14)

      // Entry threshold
      ctx.fillStyle = COLORS.amber
      ctx.font = "11px 'Outfit', sans-serif"
      ctx.fillText(`Entry: ${formatPrice(threshold)}`, padding.left + 100, 14)

      // Position info
      if (entryPrice && entrySide) {
        const posColor = entrySide === "YES" ? COLORS.yes : COLORS.no
        ctx.fillStyle = posColor
        ctx.fillText(`Position: ${entrySide} @ ${formatPrice(entryPrice)}`, padding.left + 180, 14)
      }

      // Zone labels
      ctx.font = "bold 11px 'Outfit', sans-serif"
      ctx.globalAlpha = 0.7

      // UP zone label
      ctx.fillStyle = COLORS.yes
      ctx.textAlign = "right"
      ctx.fillText("▲ UP wins", dimensions.width - padding.right - 8, padding.top + 16)

      // DOWN zone label
      ctx.fillStyle = COLORS.no
      ctx.fillText("▼ DOWN wins", dimensions.width - padding.right - 8, dimensions.height - padding.bottom - 8)

      ctx.globalAlpha = 1

      // Time labels at bottom
      ctx.font = "10px 'JetBrains Mono', monospace"
      ctx.fillStyle = COLORS.zinc
      ctx.textAlign = "center"

      // Show start, middle, and end times
      const formatTime = (ts: number) => {
        const d = new Date(ts)
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }

      const midTime = sessionStart + sessionDuration / 2

      // Start time
      ctx.textAlign = "left"
      ctx.fillText(formatTime(sessionStart), padding.left, dimensions.height - 6)

      // Mid time
      ctx.textAlign = "center"
      ctx.fillText(formatTime(midTime), padding.left + chartWidth / 2, dimensions.height - 6)

      // End time
      ctx.textAlign = "right"
      ctx.fillText(formatTime(sessionEnd), dimensions.width - padding.right, dimensions.height - 6)

      // "NOW" label at current time
      if (nowX > padding.left && nowX < dimensions.width - padding.right) {
        ctx.fillStyle = COLORS.cyan
        ctx.textAlign = "center"
        ctx.font = "bold 9px 'Outfit', sans-serif"
        ctx.fillText("NOW", nowX, dimensions.height - 6)
      }
    }

    return () => {
      if (pendingRenderRef.current) {
        clearTimeout(pendingRenderRef.current)
        pendingRenderRef.current = null
      }
    }
  }, [data, renderData, dimensions, entryPrice, entrySide, threshold, startTime, endTime, fills])

  return (
    <div ref={containerRef} className="w-full h-full min-h-[200px]">
      <canvas
        ref={canvasRef}
        style={{ width: dimensions.width, height: dimensions.height }}
      />
    </div>
  )
}
