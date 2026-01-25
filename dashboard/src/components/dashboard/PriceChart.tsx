import { useEffect, useRef, useState } from "react"
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

export function PriceChart({ data, entryPrice, entrySide, threshold = 0.65, startTime, endTime, fills = [] }: PriceChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })

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

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || dimensions.width === 0) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = dimensions.width * dpr
    canvas.height = dimensions.height * dpr
    ctx.scale(dpr, dpr)

    const padding = { top: 30, right: 60, bottom: 25, left: 10 }
    const chartWidth = dimensions.width - padding.left - padding.right
    const chartHeight = dimensions.height - padding.top - padding.bottom

    // Clear
    ctx.fillStyle = "transparent"
    ctx.fillRect(0, 0, dimensions.width, dimensions.height)

    // Debug: log data length
    console.log(`[CHART] Rendering with ${data.length} data points, startTime=${startTime}, endTime=${endTime}`)

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
    const now = Date.now()
    const sessionStart = startTime || (data[0]?.timestamp || now)
    const sessionEnd = endTime || (sessionStart + 15 * 60 * 1000)
    const sessionDuration = sessionEnd - sessionStart

    const toX = (timestamp: number) => {
      const elapsed = timestamp - sessionStart
      const progress = Math.max(0, Math.min(1, elapsed / sessionDuration))
      return padding.left + progress * chartWidth
    }

    const midY = toY(0.5)
    const nowX = toX(now) // Current time position

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

    // Get current prices
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

    // Draw YES price line (green) - shows UP probability
    if (data.length > 1) {
      ctx.beginPath()
      ctx.moveTo(toX(data[0].timestamp), toY(data[0].yesPrice))
      for (let i = 1; i < data.length; i++) {
        ctx.lineTo(toX(data[i].timestamp), toY(data[i].yesPrice))
      }
      ctx.strokeStyle = COLORS.yes
      ctx.lineWidth = 2.5
      ctx.stroke()
    }

    // Draw NO price line (red) - shows DOWN probability
    if (data.length > 1) {
      ctx.beginPath()
      ctx.moveTo(toX(data[0].timestamp), toY(data[0].noPrice))
      for (let i = 1; i < data.length; i++) {
        ctx.lineTo(toX(data[i].timestamp), toY(data[i].noPrice))
      }
      ctx.strokeStyle = COLORS.no
      ctx.lineWidth = 2.5
      ctx.stroke()
    }

    // Draw dots at key points for YES line
    if (data.length > 0) {
      const step = Math.max(1, Math.floor(data.length / 40))
      // YES dots
      ctx.fillStyle = COLORS.yes
      for (let i = 0; i < data.length; i += step) {
        const x = toX(data[i].timestamp)
        const y = toY(data[i].yesPrice)
        ctx.beginPath()
        ctx.arc(x, y, 2.5, 0, Math.PI * 2)
        ctx.fill()
      }
      // NO dots
      ctx.fillStyle = COLORS.no
      for (let i = 0; i < data.length; i += step) {
        const x = toX(data[i].timestamp)
        const y = toY(data[i].noPrice)
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

    // Current price dots - YES
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

  }, [data, dimensions, entryPrice, entrySide, threshold, startTime, endTime, fills])

  return (
    <div ref={containerRef} className="w-full h-full min-h-[200px]">
      <canvas
        ref={canvasRef}
        style={{ width: dimensions.width, height: dimensions.height }}
      />
    </div>
  )
}
