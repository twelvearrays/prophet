import { useEffect, useRef, useCallback } from "react"
import type { PriceTick } from "@/types"
import { formatPrice } from "@/lib/utils"

interface PriceChartProps {
  data: PriceTick[]
  entryPrice?: number | null
  entrySide?: "YES" | "NO" | null
  threshold?: number
  startTime?: number
  endTime?: number
  fills?: Array<{ timestamp: number; price: number; side: "YES" | "NO"; type: string }>
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

const COLORS = {
  yes: "#34d399",
  yesBg: "rgba(52, 211, 153, 0.2)",
  no: "#fb7185",
  noBg: "rgba(251, 113, 133, 0.2)",
  cyan: "#22d3ee",
  amber: "#fbbf24",
  zinc: "#71717a",
  zincDark: "#52525b",
  grid: "#27272a",
  midline: "#a1a1aa",
}

const MAX_RENDER_POINTS = 100

export function PriceChart({ data, entryPrice, entrySide, threshold = 0.65, startTime, endTime, fills = [] }: PriceChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)
  const needsRenderRef = useRef(true)

  // Store all props in refs so the render callback always sees current values
  const dataRef = useRef(data)
  const entryPriceRef = useRef(entryPrice)
  const entrySideRef = useRef(entrySide)
  const thresholdRef = useRef(threshold)
  const startTimeRef = useRef(startTime)
  const endTimeRef = useRef(endTime)
  const fillsRef = useRef(fills)

  // Update refs on every render and flag that we need a repaint
  dataRef.current = data
  entryPriceRef.current = entryPrice
  entrySideRef.current = entrySide
  thresholdRef.current = threshold
  startTimeRef.current = startTime
  endTimeRef.current = endTime
  fillsRef.current = fills
  needsRenderRef.current = true

  const doRender = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Read dimensions directly from the DOM (CSS controls display size)
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (w === 0 || h === 0) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Read current values from refs - never stale
    const currentData = dataRef.current
    const currentEntryPrice = entryPriceRef.current
    const currentEntrySide = entrySideRef.current
    const currentThreshold = thresholdRef.current
    const currentStartTime = startTimeRef.current
    const currentEndTime = endTimeRef.current
    const currentFills = fillsRef.current
    const renderData = downsampleData(currentData, MAX_RENDER_POINTS)

    const dpr = window.devicePixelRatio || 1
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)

    const padding = { top: 30, right: 60, bottom: 25, left: 10 }
    const chartWidth = w - padding.left - padding.right
    const chartHeight = h - padding.top - padding.bottom

    ctx.fillStyle = "transparent"
    ctx.fillRect(0, 0, w, h)

    if (currentData.length === 0) {
      ctx.fillStyle = "#71717a"
      ctx.font = "14px 'Outfit', sans-serif"
      ctx.textAlign = "center"
      ctx.fillText("Waiting for price data...", w / 2, h / 2)
      return
    }

    const toY = (price: number) => padding.top + (1 - price) * chartHeight

    const currentTime = Date.now()
    const sessionStart = currentStartTime || (currentData[0]?.timestamp || currentTime)
    const sessionEnd = currentEndTime || (sessionStart + 15 * 60 * 1000)
    const sessionDuration = sessionEnd - sessionStart

    const toX = (timestamp: number) => {
      const elapsed = timestamp - sessionStart
      const progress = Math.max(0, Math.min(1, elapsed / sessionDuration))
      return padding.left + progress * chartWidth
    }

    const midY = toY(0.5)
    const nowX = toX(currentTime)

    // Background zones
    const yesGradient = ctx.createLinearGradient(0, padding.top, 0, midY)
    yesGradient.addColorStop(0, "rgba(52, 211, 153, 0.12)")
    yesGradient.addColorStop(1, "rgba(52, 211, 153, 0.02)")
    ctx.fillStyle = yesGradient
    ctx.fillRect(padding.left, padding.top, chartWidth, midY - padding.top)

    const noGradient = ctx.createLinearGradient(0, midY, 0, h - padding.bottom)
    noGradient.addColorStop(0, "rgba(251, 113, 133, 0.02)")
    noGradient.addColorStop(1, "rgba(251, 113, 133, 0.12)")
    ctx.fillStyle = noGradient
    ctx.fillRect(padding.left, midY, chartWidth, h - padding.bottom - midY)

    // Grid lines
    const gridLevels = [0, 0.25, 0.5, 0.75, 1.0]
    ctx.strokeStyle = COLORS.grid
    ctx.lineWidth = 1
    for (const price of gridLevels) {
      const y = toY(price)
      ctx.beginPath()
      ctx.moveTo(padding.left, y)
      ctx.lineTo(w - padding.right, y)
      ctx.stroke()
    }

    // 50c center line
    ctx.strokeStyle = COLORS.midline
    ctx.lineWidth = 2
    ctx.setLineDash([8, 4])
    ctx.beginPath()
    ctx.moveTo(padding.left, midY)
    ctx.lineTo(w - padding.right, midY)
    ctx.stroke()
    ctx.setLineDash([])

    // Entry threshold line
    const thresholdY = toY(currentThreshold)
    ctx.strokeStyle = COLORS.amber
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(padding.left, thresholdY)
    ctx.lineTo(w - padding.right, thresholdY)
    ctx.stroke()
    ctx.setLineDash([])

    const currentYesPrice = currentData[currentData.length - 1].yesPrice
    const currentNoPrice = currentData[currentData.length - 1].noPrice

    // Entry price line
    if (currentEntryPrice && currentEntrySide) {
      const entryY = toY(currentEntryPrice)
      const entryColor = currentEntrySide === "YES" ? COLORS.yes : COLORS.no
      ctx.strokeStyle = entryColor
      ctx.lineWidth = 2
      ctx.setLineDash([6, 4])
      ctx.beginPath()
      ctx.moveTo(padding.left, entryY)
      ctx.lineTo(w - padding.right, entryY)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Future area
    if (nowX < w - padding.right) {
      ctx.fillStyle = "rgba(39, 39, 42, 0.5)"
      ctx.fillRect(nowX, padding.top, w - padding.right - nowX, chartHeight)

      ctx.strokeStyle = COLORS.cyan
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(nowX, padding.top)
      ctx.lineTo(nowX, h - padding.bottom)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // YES price line
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

    // NO price line
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

    // Dots at key points
    if (renderData.length > 0) {
      const step = Math.max(1, Math.floor(renderData.length / 20))
      ctx.fillStyle = COLORS.yes
      for (let i = 0; i < renderData.length; i += step) {
        const x = toX(renderData[i].timestamp)
        const y = toY(renderData[i].yesPrice)
        ctx.beginPath()
        ctx.arc(x, y, 2.5, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.fillStyle = COLORS.no
      for (let i = 0; i < renderData.length; i += step) {
        const x = toX(renderData[i].timestamp)
        const y = toY(renderData[i].noPrice)
        ctx.beginPath()
        ctx.arc(x, y, 2.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // Fill markers
    for (const fill of currentFills) {
      const fillX = toX(fill.timestamp)
      const fillY = toY(fill.price)
      const fillColor = fill.side === "YES" ? COLORS.yes : COLORS.no

      ctx.beginPath()
      ctx.moveTo(fillX, fillY - 8)
      ctx.lineTo(fillX - 6, fillY + 4)
      ctx.lineTo(fillX + 6, fillY + 4)
      ctx.closePath()
      ctx.fillStyle = fillColor
      ctx.fill()

      ctx.strokeStyle = "#000"
      ctx.lineWidth = 1
      ctx.stroke()

      if (fill.type === "HEDGE") {
        ctx.fillStyle = COLORS.amber
        ctx.font = "bold 8px 'Outfit', sans-serif"
        ctx.textAlign = "center"
        ctx.fillText("H", fillX, fillY - 12)
      }
    }

    // Current price dots
    const lastTick = currentData[currentData.length - 1]
    const lastX = toX(lastTick.timestamp)
    const lastYesY = toY(currentYesPrice)
    const lastNoY = toY(currentNoPrice)

    ctx.beginPath()
    ctx.arc(lastX, lastYesY, 10, 0, Math.PI * 2)
    ctx.fillStyle = COLORS.yes + "4D"
    ctx.fill()
    ctx.beginPath()
    ctx.arc(lastX, lastYesY, 6, 0, Math.PI * 2)
    ctx.fillStyle = COLORS.yes
    ctx.fill()

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
      ctx.fillText(label, w - padding.right + 8, y + 4)
    }

    // YES price label box
    const yesLabel = formatPrice(currentYesPrice)
    ctx.fillStyle = COLORS.yes
    ctx.beginPath()
    ctx.roundRect(w - padding.right + 4, lastYesY - 12, 52, 20, 4)
    ctx.fill()
    ctx.fillStyle = "#000"
    ctx.font = "bold 11px 'JetBrains Mono', monospace"
    ctx.textAlign = "left"
    ctx.fillText(yesLabel, w - padding.right + 8, lastYesY + 3)

    // NO price label box
    const noLabel = formatPrice(currentNoPrice)
    ctx.fillStyle = COLORS.no
    ctx.beginPath()
    ctx.roundRect(w - padding.right + 4, lastNoY - 12, 52, 20, 4)
    ctx.fill()
    ctx.fillStyle = "#000"
    ctx.font = "bold 11px 'JetBrains Mono', monospace"
    ctx.textAlign = "left"
    ctx.fillText(noLabel, w - padding.right + 8, lastNoY + 3)

    // Legend
    ctx.font = "bold 11px 'Outfit', sans-serif"
    ctx.textAlign = "left"

    ctx.fillStyle = COLORS.yes
    ctx.fillText("● YES", padding.left, 14)

    ctx.fillStyle = COLORS.no
    ctx.fillText("● NO", padding.left + 55, 14)

    ctx.fillStyle = COLORS.amber
    ctx.font = "11px 'Outfit', sans-serif"
    ctx.fillText(`Entry: ${formatPrice(currentThreshold)}`, padding.left + 100, 14)

    if (currentEntryPrice && currentEntrySide) {
      const posColor = currentEntrySide === "YES" ? COLORS.yes : COLORS.no
      ctx.fillStyle = posColor
      ctx.fillText(`Position: ${currentEntrySide} @ ${formatPrice(currentEntryPrice)}`, padding.left + 180, 14)
    }

    // Zone labels
    ctx.font = "bold 11px 'Outfit', sans-serif"
    ctx.globalAlpha = 0.7

    ctx.fillStyle = COLORS.yes
    ctx.textAlign = "right"
    ctx.fillText("▲ UP wins", w - padding.right - 8, padding.top + 16)

    ctx.fillStyle = COLORS.no
    ctx.fillText("▼ DOWN wins", w - padding.right - 8, h - padding.bottom - 8)

    ctx.globalAlpha = 1

    // Time labels
    ctx.font = "10px 'JetBrains Mono', monospace"
    ctx.fillStyle = COLORS.zinc
    ctx.textAlign = "center"

    const formatTime = (ts: number) => {
      const d = new Date(ts)
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    const midTime = sessionStart + sessionDuration / 2

    ctx.textAlign = "left"
    ctx.fillText(formatTime(sessionStart), padding.left, h - 6)

    ctx.textAlign = "center"
    ctx.fillText(formatTime(midTime), padding.left + chartWidth / 2, h - 6)

    ctx.textAlign = "right"
    ctx.fillText(formatTime(sessionEnd), w - padding.right, h - 6)

    // NOW label
    if (nowX > padding.left && nowX < w - padding.right) {
      ctx.fillStyle = COLORS.cyan
      ctx.textAlign = "center"
      ctx.font = "bold 9px 'Outfit', sans-serif"
      ctx.fillText("NOW", nowX, h - 6)
    }
  }, [])

  // rAF loop: only paints when needsRenderRef is flagged
  useEffect(() => {
    let running = true

    function tick() {
      if (!running) return
      if (needsRenderRef.current) {
        needsRenderRef.current = false
        doRender()
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      running = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [doRender])

  // ResizeObserver - flags repaint when container resizes
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver(() => {
      needsRenderRef.current = true
    })

    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  return (
    <div ref={containerRef} className="w-full h-full min-h-[200px]">
      <canvas
        ref={canvasRef}
        className="block w-full h-full"
      />
    </div>
  )
}
