/**
 * Settlement Lag Monitor (Type 3 Arbitrage)
 *
 * Displays markets where the outcome is effectively determined
 * but prices haven't locked to 0 or 1 yet.
 */

import { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  arbitrageScanner,
  SettlementLagScanResult,
  SettlementLagOpportunity
} from '@/lib/arbitrageScanner'
import { Clock, AlertTriangle, TrendingUp, RefreshCw, ExternalLink } from 'lucide-react'

// Signal type colors
const SIGNAL_COLORS: Record<string, string> = {
  PRICE_VOLUME_DIVERGENCE: 'bg-purple-500/20 text-purple-300',
  BOUNDARY_RUSH: 'bg-orange-500/20 text-orange-300',
  STALE_PRICE: 'bg-yellow-500/20 text-yellow-300',
  PAST_RESOLUTION: 'bg-red-500/20 text-red-300',
  EXTREME_SPREAD: 'bg-blue-500/20 text-blue-300',
}

const SIGNAL_LABELS: Record<string, string> = {
  PRICE_VOLUME_DIVERGENCE: 'Volume Spike',
  BOUNDARY_RUSH: 'Boundary Rush',
  STALE_PRICE: 'Stale Price',
  PAST_RESOLUTION: 'Past Resolution',
  EXTREME_SPREAD: 'Wide Spread',
}

/**
 * Individual opportunity card
 */
function OpportunityCard({ opportunity }: { opportunity: SettlementLagOpportunity }) {
  const profitPercent = (opportunity.potentialProfit * 100).toFixed(1)
  const confidenceColor = opportunity.confidence >= 60 ? 'text-green-400'
    : opportunity.confidence >= 40 ? 'text-yellow-400' : 'text-red-400'

  return (
    <div className="bg-zinc-800/50 rounded-lg p-4 border border-zinc-700/50">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-zinc-100 truncate">
            {opportunity.question}
          </h4>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-xs font-mono ${confidenceColor}`}>
              {opportunity.confidence}% confidence
            </span>
          </div>
        </div>

        {/* Profit badge */}
        <Badge
          variant={opportunity.hasOpportunity ? 'default' : 'secondary'}
          className={opportunity.hasOpportunity ? 'bg-green-500/20 text-green-300' : ''}
        >
          +{profitPercent}%
        </Badge>
      </div>

      {/* Price info */}
      <div className="grid grid-cols-3 gap-4 mb-3 text-center">
        <div>
          <div className="text-xs text-zinc-500 mb-1">Current</div>
          <div className="text-lg font-mono text-zinc-200">
            {(opportunity.currentPrice * 100).toFixed(1)}¢
          </div>
        </div>
        <div>
          <div className="text-xs text-zinc-500 mb-1">Expected</div>
          <div className="text-lg font-mono text-zinc-200">
            {opportunity.expectedPrice === 0 ? '0¢' : opportunity.expectedPrice === 1 ? '100¢' : `${(opportunity.expectedPrice * 100).toFixed(0)}¢`}
          </div>
        </div>
        <div>
          <div className="text-xs text-zinc-500 mb-1">Strategy</div>
          <div className={`text-sm font-medium ${
            opportunity.strategy.action === 'SELL' ? 'text-red-400' :
            opportunity.strategy.action === 'BUY' ? 'text-green-400' : 'text-zinc-400'
          }`}>
            {opportunity.strategy.action} {opportunity.strategy.side}
          </div>
        </div>
      </div>

      {/* Signals */}
      <div className="flex flex-wrap gap-1 mb-2">
        {opportunity.signals.filter(s => s.detected).map((signal, i) => (
          <span
            key={i}
            className={`text-xs px-2 py-0.5 rounded ${SIGNAL_COLORS[signal.type] || 'bg-zinc-700'}`}
            title={signal.details.reason as string || signal.type}
          >
            {SIGNAL_LABELS[signal.type] || signal.type}
          </span>
        ))}
      </div>

      {/* Strategy explanation */}
      <p className="text-xs text-zinc-400 mt-2">
        {opportunity.strategy.explanation}
      </p>
    </div>
  )
}

/**
 * Stats panel
 */
function StatsPanel({ result }: { result: SettlementLagScanResult }) {
  return (
    <div className="grid grid-cols-4 gap-4 mb-4">
      <div className="bg-zinc-800/30 rounded-lg p-3 text-center">
        <div className="text-2xl font-mono text-zinc-100">
          {result.stats.totalMarkets}
        </div>
        <div className="text-xs text-zinc-500">Total Markets</div>
      </div>
      <div className="bg-zinc-800/30 rounded-lg p-3 text-center">
        <div className="text-2xl font-mono text-zinc-100">
          {result.stats.marketsAnalyzed}
        </div>
        <div className="text-xs text-zinc-500">Analyzed</div>
      </div>
      <div className="bg-zinc-800/30 rounded-lg p-3 text-center">
        <div className="text-2xl font-mono text-green-400">
          {result.stats.opportunitiesFound}
        </div>
        <div className="text-xs text-zinc-500">Opportunities</div>
      </div>
      <div className="bg-zinc-800/30 rounded-lg p-3 text-center">
        <div className="text-2xl font-mono text-amber-400">
          {(result.stats.totalPotentialProfit * 100).toFixed(1)}%
        </div>
        <div className="text-xs text-zinc-500">Total Profit</div>
      </div>
    </div>
  )
}

/**
 * Main Settlement Lag Monitor Component
 */
export function SettlementLagMonitor() {
  const [result, setResult] = useState<SettlementLagScanResult | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [showOnlyOpportunities, setShowOnlyOpportunities] = useState(true)

  useEffect(() => {
    // Load last result
    arbitrageScanner.getLastSettlementLagResult().then(setResult)

    // Subscribe to updates
    const unsubscribe = arbitrageScanner.subscribeSettlementLag(setResult)
    return unsubscribe
  }, [])

  const handleScan = async () => {
    setIsScanning(true)
    try {
      await arbitrageScanner.scanSettlementLag()
    } finally {
      setIsScanning(false)
    }
  }

  const displayedOpportunities = result?.opportunities.filter(
    o => !showOnlyOpportunities || o.hasOpportunity
  ) || []

  return (
    <Card className="bg-zinc-900/50 border-zinc-800">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-amber-400" />
            <CardTitle className="text-lg">Settlement Lag (Type 3)</CardTitle>
            <Badge variant="outline" className="text-xs">
              {result?.stats.opportunitiesFound || 0} opportunities
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowOnlyOpportunities(!showOnlyOpportunities)}
              className={showOnlyOpportunities ? 'bg-amber-500/20' : ''}
            >
              {showOnlyOpportunities ? 'Show All' : 'Only Opportunities'}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleScan}
              disabled={isScanning}
            >
              <RefreshCw className={`w-4 h-4 mr-1 ${isScanning ? 'animate-spin' : ''}`} />
              {isScanning ? 'Scanning...' : 'Scan'}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {/* Info banner */}
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-amber-200/80">
              <strong>Settlement Lag:</strong> Detects markets where the outcome is effectively
              determined but prices haven't locked. Look for high-confidence signals like
              "Past Resolution" or "Boundary Rush" combined with significant price deviation.
            </div>
          </div>
        </div>

        {/* Stats */}
        {result && <StatsPanel result={result} />}

        {/* Opportunities list */}
        {displayedOpportunities.length > 0 ? (
          <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
            {displayedOpportunities.map((opp, i) => (
              <OpportunityCard key={opp.marketId || i} opportunity={opp} />
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-zinc-500">
            {result
              ? 'No settlement lag opportunities found'
              : 'Click Scan to search for settlement lag opportunities'}
          </div>
        )}

        {/* Last scan time */}
        {result && (
          <div className="text-xs text-zinc-500 mt-4 text-center">
            Last scan: {new Date(result.timestamp).toLocaleTimeString()}
            {result.scanTime && ` (${(result.scanTime / 1000).toFixed(1)}s)`}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default SettlementLagMonitor
