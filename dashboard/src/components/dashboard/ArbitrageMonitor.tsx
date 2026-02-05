import { useState, useEffect, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { arbitrageScanner, type MultiOutcomeEvent, type ScanResult } from '@/lib/arbitrageScanner'

// ============================================================================
// COMPONENTS
// ============================================================================

interface SumMeterProps {
  value: number // Total sum of outcome prices
  label?: string
}

function SumMeter({ value, label = 'Probability Sum' }: SumMeterProps) {
  const deviation = Math.abs(value - 1) * 100
  const isOverpriced = value > 1
  const isUnderpriced = value < 1

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-zinc-500">{label}</span>
        <span className={`font-mono ${
          deviation > 2 ? (isOverpriced ? 'text-red-400' : 'text-emerald-400') : 'text-zinc-400'
        }`}>
          Σ = {value.toFixed(3)} {deviation > 1 && `(${isOverpriced ? '+' : '-'}${deviation.toFixed(1)}%)`}
        </span>
      </div>
      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden relative">
        {/* Center marker at 1.0 */}
        <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-zinc-600 z-10" />
        {/* Fill bar */}
        <div
          className={`h-full transition-all duration-300 ${
            isOverpriced ? 'bg-red-500 ml-1/2' : 'bg-emerald-500'
          }`}
          style={{
            width: `${Math.min(deviation * 5, 50)}%`,
            marginLeft: isUnderpriced ? `${50 - Math.min(deviation * 5, 50)}%` : '50%',
          }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-zinc-600">
        <span>0.8</span>
        <span className="text-amber-500/70">1.0 (fair)</span>
        <span>1.2</span>
      </div>
    </div>
  )
}

interface EventRowProps {
  event: MultiOutcomeEvent
  rank: number
  onClick?: () => void
}

function EventRow({ event, rank, onClick }: EventRowProps) {
  const mispricingPct = event.absoluteMispricing * 100

  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-3 py-2 px-3 rounded-lg cursor-pointer transition-colors ${
        event.qualifies
          ? 'bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/15'
          : 'bg-zinc-800/50 hover:bg-zinc-800/80'
      }`}
    >
      {/* Rank Badge */}
      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
        event.qualifies ? 'bg-emerald-500/20 text-emerald-400' :
        rank <= 3 ? 'bg-amber-500/20 text-amber-400' : 'bg-zinc-700 text-zinc-500'
      }`}>
        {event.qualifies ? '✓' : rank}
      </div>

      {/* Event Info */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-zinc-200 truncate" title={event.title}>
          {event.title.length > 40 ? event.title.slice(0, 40) + '...' : event.title}
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="text-cyan-400">{event.numOutcomes} outcomes</span>
          <span>
            Σ: <span className={`font-mono ${
              event.absoluteMispricing > 0.02 ? (event.mispricing > 0 ? 'text-red-400' : 'text-emerald-400') : 'text-zinc-400'
            }`}>
              {event.totalYesPrice.toFixed(3)}
            </span>
          </span>
          <span className="text-zinc-600">
            ${event.minLiquidity.toFixed(0)} liq
          </span>
        </div>
      </div>

      {/* Status */}
      <div className="text-right min-w-[80px]">
        <div className={`text-sm font-mono ${
          event.qualifies ? 'text-emerald-400' : 'text-zinc-400'
        }`}>
          {event.mispricing >= 0 ? '+' : ''}{mispricingPct.toFixed(2)}%
        </div>
        <div className={`text-[10px] ${event.qualifies ? 'text-emerald-500' : 'text-zinc-600'}`}>
          {event.qualifies ? `${event.opportunityType}` :
           event.opportunityType === 'BUY_ALL' ? '📈 underbought' :
           event.opportunityType === 'SELL_ALL' ? '📉 overbought' : 'fair'}
        </div>
      </div>
    </div>
  )
}

interface EventDetailProps {
  event: MultiOutcomeEvent
  onClose: () => void
}

function EventDetail({ event, onClose }: EventDetailProps) {
  const polymarketUrl = event.url || `https://polymarket.com/event/${event.slug}`

  return (
    <div className="p-4 rounded-lg bg-zinc-800/80 border border-zinc-700 space-y-3">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-zinc-200">{event.title}</h4>
          <p className="text-xs text-zinc-500 mt-1">
            {event.numOutcomes} outcomes • {event.isNegRisk ? 'NegRisk' : 'Standard'} market
            <a
              href={polymarketUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 text-cyan-400 hover:text-cyan-300 underline"
            >
              View on Polymarket →
            </a>
          </p>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg ml-2">×</button>
      </div>

      {/* Sum Analysis */}
      <div className="grid grid-cols-4 gap-2">
        <div className="p-2 rounded bg-zinc-900/50">
          <div className="text-[10px] text-zinc-500">Sum of Prices</div>
          <div className={`text-lg font-mono ${
            event.absoluteMispricing > 0.02 ? (event.mispricing > 0 ? 'text-red-400' : 'text-emerald-400') : 'text-zinc-300'
          }`}>
            {event.totalYesPrice.toFixed(4)}
          </div>
        </div>
        <div className="p-2 rounded bg-zinc-900/50">
          <div className="text-[10px] text-zinc-500">Mispricing</div>
          <div className={`text-lg font-mono ${event.absoluteMispricing > 0.02 ? 'text-amber-400' : 'text-zinc-300'}`}>
            {(event.mispricing * 100).toFixed(2)}%
          </div>
        </div>
        <div className="p-2 rounded bg-zinc-900/50">
          <div className="text-[10px] text-zinc-500">Raw Profit</div>
          <div className="text-lg font-mono text-cyan-400">{(event.rawProfit * 100).toFixed(2)}%</div>
        </div>
        <div className="p-2 rounded bg-zinc-900/50">
          <div className="text-[10px] text-zinc-500">After Fees</div>
          <div className={`text-lg font-mono ${event.profitAfterFees > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {(event.profitAfterFees * 100).toFixed(2)}%
          </div>
        </div>
      </div>

      {/* Outcomes List */}
      <div className="p-3 rounded border border-zinc-700/50 bg-zinc-900/30">
        <div className="text-xs text-zinc-500 mb-2">Outcome Prices (should sum to 1.00)</div>
        <div className="space-y-1 max-h-[150px] overflow-y-auto">
          {event.outcomes.map((outcome, i) => (
            <div key={outcome.id} className="flex items-center justify-between text-xs py-1 border-b border-zinc-800 last:border-0">
              <span className="text-zinc-400 truncate flex-1" title={outcome.groupItemTitle}>
                {i + 1}. {outcome.groupItemTitle.slice(0, 35)}{outcome.groupItemTitle.length > 35 ? '...' : ''}
              </span>
              <span className="font-mono text-cyan-400 ml-2">{outcome.price.toFixed(3)}</span>
              <span className="text-zinc-600 ml-2 w-16 text-right">${outcome.liquidity.toFixed(0)}</span>
            </div>
          ))}
        </div>
        <div className="flex justify-between mt-2 pt-2 border-t border-zinc-700 text-xs font-medium">
          <span className="text-zinc-400">Total:</span>
          <span className={`font-mono ${
            event.absoluteMispricing > 0.02 ? (event.mispricing > 0 ? 'text-red-400' : 'text-emerald-400') : 'text-zinc-300'
          }`}>
            {event.totalYesPrice.toFixed(4)} {event.absoluteMispricing > 0.01 && `(${event.mispricing > 0 ? '+' : ''}${(event.mispricing * 100).toFixed(2)}%)`}
          </span>
        </div>
      </div>

      {/* Analysis */}
      <div className={`p-3 rounded border ${
        event.qualifies
          ? 'bg-emerald-500/10 border-emerald-500/20'
          : 'bg-zinc-900/50 border-zinc-700/50'
      }`}>
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-sm font-medium ${event.qualifies ? 'text-emerald-400' : 'text-zinc-400'}`}>
            {event.qualifies ? '💰 Arbitrage Opportunity' : '❌ Why This Doesn\'t Qualify'}
          </span>
        </div>
        <div className="space-y-1">
          {event.reasons.map((reason, i) => (
            <p key={i} className={`text-xs ${event.qualifies ? 'text-emerald-300' : 'text-zinc-500'}`}>
              • {reason}
            </p>
          ))}
        </div>

        {event.qualifies && (
          <div className="mt-3 pt-3 border-t border-emerald-500/20 text-xs text-zinc-400 space-y-1">
            <p className="text-emerald-400 font-medium">Strategy: {event.opportunityType}</p>
            {event.opportunityType === 'BUY_ALL' ? (
              <>
                <p>• Buy YES on all {event.numOutcomes} outcomes</p>
                <p>• Total cost: ${event.totalYesPrice.toFixed(4)}</p>
                <p>• Guaranteed payout: $1.00 (one outcome wins)</p>
              </>
            ) : (
              <>
                <p>• Sell YES on all {event.numOutcomes} outcomes</p>
                <p>• Total received: ${event.totalYesPrice.toFixed(4)}</p>
                <p>• Maximum liability: $1.00 (one outcome wins)</p>
              </>
            )}
            <p className="text-emerald-400 font-medium mt-2">
              Guaranteed profit: {(event.profitAfterFees * 100).toFixed(2)}%
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

interface ArbitrageMonitorProps {
  config?: {
    minDivergence?: number
  }
  onOpportunityDetected?: (opp: { count: number; best: MultiOutcomeEvent; timestamp: number }) => void
}

export function ArbitrageMonitor({ config: _config, onOpportunityDetected }: ArbitrageMonitorProps) {
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<MultiOutcomeEvent | null>(null)
  const [scanInterval, setScanInterval] = useState<number>(30)
  const [displayCount, setDisplayCount] = useState<number>(20)
  const [showOnlyOpportunities, setShowOnlyOpportunities] = useState(false)
  const stopScanRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const unsubscribeConnection = arbitrageScanner.onConnectionChange(setIsConnected)
    const unsubscribeResults = arbitrageScanner.subscribe((result) => {
      if (!result) return
      setScanResult(result)
      setIsScanning(false)

      const opportunities = result.opportunities || []
      if (opportunities.length > 0 && onOpportunityDetected) {
        onOpportunityDetected({
          count: opportunities.length,
          best: opportunities[0],
          timestamp: Date.now(),
        })
      }
    })

    return () => {
      unsubscribeConnection()
      unsubscribeResults()
    }
  }, [onOpportunityDetected])

  useEffect(() => {
    if (stopScanRef.current) {
      stopScanRef.current()
    }
    stopScanRef.current = arbitrageScanner.startContinuousScan(scanInterval * 1000)

    return () => {
      if (stopScanRef.current) {
        stopScanRef.current()
      }
    }
  }, [scanInterval])

  const handleManualScan = async () => {
    setIsScanning(true)
    try {
      console.log('[ARB-UI] Starting manual scan...')
      const result = await arbitrageScanner.scan()
      console.log('[ARB-UI] Scan complete:', result)
      setScanResult(result)
      setIsConnected(true)
    } catch (e) {
      console.error('[ARB-UI] Scan error:', e)
    } finally {
      setIsScanning(false)
    }
  }

  const events = scanResult?.events || []
  const displayEvents = showOnlyOpportunities
    ? events.filter(e => e.qualifies).slice(0, displayCount)
    : events.slice(0, displayCount)
  const maxMispricing = events.length > 0 ? events[0].absoluteMispricing : 0
  const opportunityCount = scanResult?.qualifyingOpportunities || 0
  const errors = scanResult?.errors || []

  // Calculate average sum for visualization
  const avgSum = events.length > 0
    ? events.reduce((sum, e) => sum + e.totalYesPrice, 0) / events.length
    : 1

  return (
    <div className="space-y-4">
      {/* Header Card */}
      <Card className="border-zinc-700">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${
                isScanning ? 'bg-cyan-500 animate-pulse' :
                isConnected ? 'bg-emerald-500' : 'bg-red-500'
              }`} />
              <span className="text-zinc-300">🎯 Multi-Outcome Arbitrage</span>
              {!isConnected && (
                <span className="text-[10px] text-red-400 ml-1">(disconnected)</span>
              )}
            </CardTitle>
            <button
              onClick={handleManualScan}
              disabled={isScanning}
              className="px-2 py-1 text-xs rounded bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-50"
            >
              {isScanning ? 'Scanning...' : 'Scan Events'}
            </button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isConnected && errors.length > 0 && (
            <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              <div className="font-medium mb-1">⚠️ Backend not connected</div>
              <div className="text-red-300/70">
                Start: <code className="bg-zinc-800 px-1 rounded">cd dashboard/backend && node server.js</code>
              </div>
            </div>
          )}

          {/* Stats Row */}
          <div className="grid grid-cols-4 gap-2">
            <div className="text-center p-2 rounded bg-zinc-800/50">
              <div className="text-xl font-mono text-cyan-400">{scanResult?.multiOutcomeEvents || 0}</div>
              <div className="text-[10px] text-zinc-500">Multi-Outcome</div>
            </div>
            <div className="text-center p-2 rounded bg-zinc-800/50">
              <div className={`text-xl font-mono ${opportunityCount > 0 ? 'text-emerald-400' : 'text-zinc-400'}`}>
                {opportunityCount}
              </div>
              <div className="text-[10px] text-zinc-500">Opportunities</div>
            </div>
            <div className="text-center p-2 rounded bg-zinc-800/50">
              <div className="text-xl font-mono text-amber-400">{(maxMispricing * 100).toFixed(1)}%</div>
              <div className="text-[10px] text-zinc-500">Max Deviation</div>
            </div>
            <div className="text-center p-2 rounded bg-zinc-800/50">
              <div className="text-xl font-mono text-zinc-300">{((scanResult?.scanTime || 0) / 1000).toFixed(1)}s</div>
              <div className="text-[10px] text-zinc-500">Scan Time</div>
            </div>
          </div>

          {/* Sum Meter */}
          <SumMeter value={avgSum} label="Avg Probability Sum" />

          {/* Controls */}
          <div className="flex items-center gap-4">
            <div className="flex-1 space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Scan Interval</span>
                <span className="font-mono text-zinc-400">{scanInterval}s</span>
              </div>
              <input
                type="range"
                min={15}
                max={120}
                step={15}
                value={scanInterval}
                onChange={(e) => setScanInterval(Number(e.target.value))}
                className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={showOnlyOpportunities}
                onChange={(e) => setShowOnlyOpportunities(e.target.checked)}
                className="rounded bg-zinc-700 border-zinc-600"
              />
              Only opps
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Selected Event Detail */}
      {selectedEvent && (
        <EventDetail
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}

      {/* Events List */}
      <Card className="border-zinc-700">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs text-zinc-400">
              {showOnlyOpportunities ? 'Arbitrage Opportunities' : 'Multi-Outcome Events (sorted by mispricing)'}
            </CardTitle>
            <select
              value={displayCount}
              onChange={(e) => setDisplayCount(Number(e.target.value))}
              className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-400"
            >
              <option value={10}>Top 10</option>
              <option value={20}>Top 20</option>
              <option value={50}>Top 50</option>
            </select>
          </div>
        </CardHeader>
        <CardContent className="space-y-1 max-h-[400px] overflow-y-auto">
          {displayEvents.length === 0 ? (
            <div className="text-center py-8 text-zinc-500">
              <div className="text-3xl mb-2">{isScanning ? '⏳' : '🔍'}</div>
              <div className="text-sm">
                {isScanning ? 'Scanning multi-outcome events...' :
                 !isConnected ? 'Waiting for backend...' :
                 showOnlyOpportunities ? 'No qualifying opportunities' :
                 'Click "Scan Events" to search'}
              </div>
            </div>
          ) : (
            displayEvents.map((event, index) => (
              <EventRow
                key={event.id}
                event={event}
                rank={index + 1}
                onClick={() => setSelectedEvent(event)}
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* Footer */}
      {scanResult && scanResult.multiOutcomeEvents > 0 && (
        <div className="text-[10px] text-zinc-600 px-2">
          Last scan: {new Date(scanResult.timestamp).toLocaleTimeString()} •
          {scanResult.multiOutcomeEvents} multi-outcome events •
          {opportunityCount} qualify after fees •
          Type: {scanResult.scanType}
        </div>
      )}
    </div>
  )
}
