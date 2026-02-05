/**
 * Cross-Market Dependency Monitor
 *
 * Type 2 Arbitrage: Finds logical relationships between markets
 * - Temporal: "X by March" should have P <= "X by June"
 * - Threshold: "Price > $100" should have P <= "Price > $50"
 */

import { useState, useEffect } from 'react'
import {
  arbitrageScanner,
  CrossMarketScanResult,
  CrossMarketDependency,
} from '@/lib/arbitrageScanner'

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

function DependencyCard({ dep }: { dep: CrossMarketDependency }) {
  const typeColors = {
    temporal: 'bg-blue-900/30 border-blue-500/30',
    threshold: 'bg-purple-900/30 border-purple-500/30',
  }

  const typeLabels = {
    temporal: '⏰ Temporal',
    threshold: '📊 Threshold',
  }

  return (
    <div className={`border rounded-lg p-4 ${typeColors[dep.type]} ${dep.qualifies ? 'ring-2 ring-green-500/50' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-mono px-2 py-1 bg-black/30 rounded">
          {typeLabels[dep.type]}
        </span>
        {dep.qualifies && (
          <span className="text-xs font-bold text-green-400 px-2 py-1 bg-green-900/30 rounded">
            🎯 OPPORTUNITY
          </span>
        )}
        {dep.violation && !dep.qualifies && (
          <span className="text-xs text-yellow-400 px-2 py-1 bg-yellow-900/30 rounded">
            ⚠️ Violation (fees too high)
          </span>
        )}
      </div>

      {/* Markets */}
      <div className="space-y-2 mb-3">
        <div className="bg-black/20 rounded p-2">
          <div className="text-xs text-gray-400 mb-1">Market A (should be ≤)</div>
          <div className="text-sm truncate">{dep.marketA.question}</div>
          <div className="text-lg font-mono font-bold text-blue-400">
            {(dep.marketA.price * 100).toFixed(1)}%
          </div>
        </div>
        <div className="text-center text-gray-500 text-xs">
          Expected: A {dep.expectedRelation === 'A <= B' ? '≤' : '≥'} B
        </div>
        <div className="bg-black/20 rounded p-2">
          <div className="text-xs text-gray-400 mb-1">Market B</div>
          <div className="text-sm truncate">{dep.marketB.question}</div>
          <div className="text-lg font-mono font-bold text-purple-400">
            {(dep.marketB.price * 100).toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Reasoning */}
      <div className="text-xs text-gray-400 mb-2">
        {dep.reasoning}
      </div>

      {/* Profit Info */}
      {dep.violation && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-black/20 rounded p-2">
            <div className="text-gray-400">Raw Profit</div>
            <div className={`font-mono ${dep.arbitrageProfit > 0 ? 'text-green-400' : 'text-gray-400'}`}>
              {(dep.arbitrageProfit * 100).toFixed(2)}%
            </div>
          </div>
          <div className="bg-black/20 rounded p-2">
            <div className="text-gray-400">After Fees</div>
            <div className={`font-mono ${dep.profitAfterFees > 0 ? 'text-green-400' : 'text-red-400'}`}>
              {(dep.profitAfterFees * 100).toFixed(2)}%
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatsPanel({ stats }: { stats: CrossMarketScanResult['stats'] }) {
  return (
    <div className="grid grid-cols-5 gap-2 mb-4">
      <div className="bg-gray-800/50 rounded p-2 text-center">
        <div className="text-xs text-gray-400">Markets</div>
        <div className="text-lg font-bold">{stats.totalMarkets}</div>
      </div>
      <div className="bg-blue-900/30 rounded p-2 text-center">
        <div className="text-xs text-gray-400">Temporal</div>
        <div className="text-lg font-bold text-blue-400">{stats.temporalDependencies}</div>
      </div>
      <div className="bg-purple-900/30 rounded p-2 text-center">
        <div className="text-xs text-gray-400">Threshold</div>
        <div className="text-lg font-bold text-purple-400">{stats.thresholdDependencies}</div>
      </div>
      <div className="bg-yellow-900/30 rounded p-2 text-center">
        <div className="text-xs text-gray-400">Violations</div>
        <div className="text-lg font-bold text-yellow-400">{stats.violations}</div>
      </div>
      <div className="bg-green-900/30 rounded p-2 text-center">
        <div className="text-xs text-gray-400">Opportunities</div>
        <div className="text-lg font-bold text-green-400">{stats.qualifyingOpportunities}</div>
      </div>
    </div>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function CrossMarketMonitor() {
  const [result, setResult] = useState<CrossMarketScanResult | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [showOnlyOpportunities, setShowOnlyOpportunities] = useState(false)
  const [filterType, setFilterType] = useState<'all' | 'temporal' | 'threshold'>('all')

  useEffect(() => {
    // Try to get cached result on mount
    arbitrageScanner.getLastCrossMarketResult().then(setResult)

    // Subscribe to updates
    const unsubscribe = arbitrageScanner.subscribeCrossMarket(setResult)
    return unsubscribe
  }, [])

  const handleScan = async () => {
    setIsScanning(true)
    try {
      console.log('[CROSS-MARKET-UI] Starting scan...')
      const scanResult = await arbitrageScanner.scanCrossMarket()
      console.log('[CROSS-MARKET-UI] Scan complete:', scanResult)
      setResult(scanResult)
    } catch (e) {
      console.error('[CROSS-MARKET-UI] Scan error:', e)
    } finally {
      setIsScanning(false)
    }
  }

  // Filter dependencies
  const filteredDeps = result?.dependencies.filter(dep => {
    if (showOnlyOpportunities && !dep.qualifies) return false
    if (filterType !== 'all' && dep.type !== filterType) return false
    return true
  }) || []

  // Sort by violation status and profit
  const sortedDeps = [...filteredDeps].sort((a, b) => {
    if (a.qualifies !== b.qualifies) return a.qualifies ? -1 : 1
    if (a.violation !== b.violation) return a.violation ? -1 : 1
    return b.profitAfterFees - a.profitAfterFees
  })

  return (
    <div className="bg-gray-900/50 rounded-lg p-4 border border-gray-700">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-bold">Cross-Market Dependencies</h3>
          <p className="text-xs text-gray-400">
            Type 2 Arbitrage: Logical relationships between markets
          </p>
        </div>
        <button
          onClick={handleScan}
          disabled={isScanning}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded text-sm font-medium"
        >
          {isScanning ? 'Scanning...' : 'Scan'}
        </button>
      </div>

      {/* Stats */}
      {result && <StatsPanel stats={result.stats} />}

      {/* Filters */}
      <div className="flex items-center gap-4 mb-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showOnlyOpportunities}
            onChange={e => setShowOnlyOpportunities(e.target.checked)}
            className="rounded"
          />
          Only Opportunities
        </label>

        <select
          value={filterType}
          onChange={e => setFilterType(e.target.value as 'all' | 'temporal' | 'threshold')}
          className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm"
        >
          <option value="all">All Types</option>
          <option value="temporal">Temporal Only</option>
          <option value="threshold">Threshold Only</option>
        </select>

        <span className="text-xs text-gray-400 ml-auto">
          Showing {sortedDeps.length} of {result?.dependencies.length || 0}
        </span>
      </div>

      {/* Dependencies List */}
      {sortedDeps.length > 0 ? (
        <div className="grid gap-4 max-h-[600px] overflow-y-auto">
          {sortedDeps.slice(0, 20).map((dep, i) => (
            <DependencyCard key={`${dep.marketA.id}-${dep.marketB.id}-${i}`} dep={dep} />
          ))}
          {sortedDeps.length > 20 && (
            <div className="text-center text-gray-400 text-sm py-2">
              + {sortedDeps.length - 20} more dependencies
            </div>
          )}
        </div>
      ) : result ? (
        <div className="text-center py-8 text-gray-400">
          {showOnlyOpportunities
            ? 'No qualifying opportunities found'
            : 'No dependencies found. Try scanning.'}
        </div>
      ) : (
        <div className="text-center py-8 text-gray-400">
          Click "Scan" to find cross-market dependencies
        </div>
      )}

      {/* Scan Time */}
      {result?.stats.scanTime && (
        <div className="text-xs text-gray-500 mt-4 text-right">
          Last scan: {(result.stats.scanTime / 1000).toFixed(1)}s
        </div>
      )}
    </div>
  )
}
