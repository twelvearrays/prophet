/**
 * Audit Log Panel
 *
 * Real-time trade activity feed with filtering and export capabilities.
 * Video game-inspired design with color-coded events and severity levels.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { auditLog, AuditLogEntry, AuditEventType, AuditSeverity, SessionAudit } from '@/lib/auditLog'

// Event type icons and colors
const EVENT_CONFIG: Record<AuditEventType, { icon: string; color: string; label: string }> = {
  SESSION_START: { icon: '🚀', color: 'text-cyan-400', label: 'START' },
  SESSION_END: { icon: '🏁', color: 'text-zinc-400', label: 'END' },
  PRICE_UPDATE: { icon: '📊', color: 'text-zinc-500', label: 'PRICE' },
  ENTRY_SIGNAL: { icon: '🎯', color: 'text-cyan-400', label: 'ENTRY' },
  ENTRY_SKIP: { icon: '⏭️', color: 'text-amber-400', label: 'SKIP' },
  ENTRY_FILL: { icon: '✅', color: 'text-emerald-400', label: 'FILL' },
  SCALE_SIGNAL: { icon: '📈', color: 'text-cyan-400', label: 'SCALE' },
  SCALE_FILL: { icon: '✅', color: 'text-emerald-400', label: 'FILL' },
  HEDGE_SIGNAL: { icon: '🛡️', color: 'text-amber-400', label: 'HEDGE' },
  HEDGE_SKIP: { icon: '⚠️', color: 'text-amber-500', label: 'SKIP' },
  HEDGE_FILL: { icon: '🛡️', color: 'text-amber-400', label: 'HEDGE' },
  TAKE_PROFIT: { icon: '💰', color: 'text-emerald-400', label: 'PROFIT' },
  LOSER_EXIT: { icon: '📉', color: 'text-rose-400', label: 'SOLD' },
  WINNER_EXIT: { icon: '🏆', color: 'text-emerald-400', label: 'WIN' },
  FORCE_EXIT: { icon: '⏰', color: 'text-amber-400', label: 'EXIT' },
  MAKER_ORDER_PLACED: { icon: '📝', color: 'text-purple-400', label: 'ORDER' },
  MAKER_ORDER_FILLED: { icon: '✅', color: 'text-purple-400', label: 'FILL' },
  MAKER_ORDER_CANCELLED: { icon: '❌', color: 'text-zinc-400', label: 'CANCEL' },
  CONFIG_CHANGE: { icon: '⚙️', color: 'text-zinc-400', label: 'CONFIG' },
  ERROR: { icon: '🚨', color: 'text-rose-500', label: 'ERROR' },
  // Order lifecycle events
  ORDER_CANCELLED: { icon: '❌', color: 'text-amber-400', label: 'CANCEL' },
  ORDER_FILLED: { icon: '✅', color: 'text-emerald-400', label: 'FILL' },
  ORDER_CONFIRMING: { icon: '⏳', color: 'text-zinc-400', label: 'CONFIRM' },
  // Execution events
  ENTER_EXECUTED: { icon: '🎯', color: 'text-emerald-400', label: 'ENTER' },
  SCALE_EXECUTED: { icon: '📈', color: 'text-emerald-400', label: 'SCALE' },
  HEDGE_EXECUTED: { icon: '🛡️', color: 'text-amber-400', label: 'HEDGE' },
  CLOSE_EXECUTED: { icon: '💰', color: 'text-emerald-400', label: 'CLOSE' },
}

const SEVERITY_STYLES: Record<AuditSeverity, string> = {
  info: 'border-l-zinc-500',
  action: 'border-l-cyan-500',
  warning: 'border-l-amber-500',
  error: 'border-l-rose-500',
  profit: 'border-l-emerald-500',
  loss: 'border-l-rose-500',
}

interface AuditLogProps {
  sessionId?: string // Filter to specific session
  maxHeight?: string
}

export function AuditLog({ sessionId, maxHeight = '400px' }: AuditLogProps) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [filter, setFilter] = useState<{
    severity: AuditSeverity[]
    eventTypes: AuditEventType[]
    asset: string
    strategy: 'ALL' | 'MOMENTUM' | 'DUAL_ENTRY'
  }>({
    severity: ['action', 'warning', 'error', 'profit', 'loss'], // Exclude 'info' by default
    eventTypes: [],
    asset: '',
    strategy: 'ALL',
  })
  const [showFilters, setShowFilters] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)

  // Subscribe to new entries
  useEffect(() => {
    // Load existing entries
    setEntries(auditLog.getEntries({ sessionId }))

    // Subscribe to new entries
    const unsubscribe = auditLog.subscribe((entry) => {
      if (sessionId && entry.sessionId !== sessionId) return
      setEntries(prev => [...prev, entry].slice(-500)) // Keep last 500
    })

    return unsubscribe
  }, [sessionId])

  // Filtered entries
  const filteredEntries = useMemo(() => {
    return entries.filter(e => {
      if (filter.severity.length && !filter.severity.includes(e.severity)) return false
      if (filter.eventTypes.length && !filter.eventTypes.includes(e.eventType)) return false
      if (filter.asset && e.asset !== filter.asset) return false
      if (filter.strategy !== 'ALL' && e.strategy !== filter.strategy) return false
      return true
    }).slice(-100) // Show last 100
  }, [entries, filter])

  // Export current session
  const handleExport = useCallback((format: 'json' | 'markdown') => {
    const id = sessionId || filteredEntries[0]?.sessionId
    if (!id) return

    const content = format === 'json'
      ? auditLog.exportSessionToJSON(id)
      : auditLog.exportSessionToMarkdown(id)

    const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `audit-${id.slice(0, 8)}.${format === 'json' ? 'json' : 'md'}`
    a.click()
    URL.revokeObjectURL(url)
  }, [sessionId, filteredEntries])

  // Clear logs
  const handleClear = () => {
    if (confirm('Clear all audit logs? This cannot be undone.')) {
      auditLog.clear()
      setEntries([])
    }
  }

  // Unique assets for filter
  const assets = useMemo(() => {
    const set = new Set(entries.map(e => e.asset))
    return [...set].sort()
  }, [entries])

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">📋</span>
          <h3 className="text-sm font-medium text-zinc-300">Audit Log</h3>
          <span className="text-xs text-zinc-500 font-mono">
            ({filteredEntries.length} events)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              autoScroll ? 'bg-cyan-500/20 text-cyan-400' : 'bg-zinc-700 text-zinc-400'
            }`}
          >
            {autoScroll ? '⬇️ Auto' : '⏸️ Paused'}
          </button>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              showFilters ? 'bg-cyan-500/20 text-cyan-400' : 'bg-zinc-700 text-zinc-400'
            }`}
          >
            🔍 Filter
          </button>
          <button
            onClick={() => handleExport('markdown')}
            className="px-2 py-1 text-xs rounded bg-zinc-700 text-zinc-400 hover:bg-zinc-600"
          >
            📄 Export
          </button>
          <button
            onClick={handleClear}
            className="px-2 py-1 text-xs rounded bg-zinc-700 text-rose-400 hover:bg-zinc-600"
          >
            🗑️
          </button>
        </div>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="p-3 border-b border-zinc-800 space-y-2 bg-zinc-800/50">
          <div className="flex flex-wrap gap-2">
            {/* Severity filters */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-zinc-500">Severity:</span>
              {(['action', 'warning', 'error', 'profit', 'loss'] as AuditSeverity[]).map(sev => (
                <button
                  key={sev}
                  onClick={() => setFilter(f => ({
                    ...f,
                    severity: f.severity.includes(sev)
                      ? f.severity.filter(s => s !== sev)
                      : [...f.severity, sev]
                  }))}
                  className={`px-1.5 py-0.5 text-xs rounded capitalize ${
                    filter.severity.includes(sev)
                      ? 'bg-cyan-500/20 text-cyan-400'
                      : 'bg-zinc-700 text-zinc-500'
                  }`}
                >
                  {sev}
                </button>
              ))}
            </div>

            {/* Strategy filter */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-zinc-500">Strategy:</span>
              {(['ALL', 'MOMENTUM', 'DUAL_ENTRY'] as const).map(strat => (
                <button
                  key={strat}
                  onClick={() => setFilter(f => ({ ...f, strategy: strat }))}
                  className={`px-1.5 py-0.5 text-xs rounded ${
                    filter.strategy === strat
                      ? 'bg-cyan-500/20 text-cyan-400'
                      : 'bg-zinc-700 text-zinc-500'
                  }`}
                >
                  {strat === 'ALL' ? 'All' : strat === 'MOMENTUM' ? 'Mom' : 'Dual'}
                </button>
              ))}
            </div>

            {/* Asset filter */}
            {assets.length > 1 && (
              <div className="flex items-center gap-1">
                <span className="text-xs text-zinc-500">Asset:</span>
                <select
                  value={filter.asset}
                  onChange={e => setFilter(f => ({ ...f, asset: e.target.value }))}
                  className="px-1.5 py-0.5 text-xs rounded bg-zinc-700 text-zinc-300 border-none"
                >
                  <option value="">All</option>
                  {assets.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Event Feed */}
      <div
        className="overflow-y-auto font-mono text-xs"
        style={{ maxHeight }}
        ref={el => {
          if (el && autoScroll) el.scrollTop = el.scrollHeight
        }}
      >
        {filteredEntries.length === 0 ? (
          <div className="p-4 text-center text-zinc-500">
            No events logged yet. Start trading to see activity.
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/50">
            {filteredEntries.map((entry) => {
              const config = EVENT_CONFIG[entry.eventType] || EVENT_CONFIG.ERROR
              return (
                <div
                  key={entry.id}
                  className={`p-2 border-l-2 ${SEVERITY_STYLES[entry.severity]} hover:bg-zinc-800/30 transition-colors`}
                >
                  <div className="flex items-start gap-2">
                    {/* Time */}
                    <span className="text-zinc-500 w-16 flex-shrink-0">
                      {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>

                    {/* Icon + Type */}
                    <span className={`${config.color} w-16 flex-shrink-0 flex items-center gap-1`}>
                      <span>{config.icon}</span>
                      <span>{config.label}</span>
                    </span>

                    {/* Asset + Strategy */}
                    <span className="w-16 flex-shrink-0">
                      <span className="text-zinc-300">{entry.asset}</span>
                      <span className="text-zinc-600 text-[10px] ml-1">
                        {entry.strategy === 'DUAL_ENTRY' ? 'D' : 'M'}
                      </span>
                    </span>

                    {/* Time remaining */}
                    <span className="text-zinc-500 w-12 flex-shrink-0">
                      [{entry.context.timeRemainingFormatted}]
                    </span>

                    {/* Prices */}
                    <span className="w-24 flex-shrink-0">
                      <span className="text-emerald-400">{(entry.context.yesPrice * 100).toFixed(0)}¢</span>
                      <span className="text-zinc-600">/</span>
                      <span className="text-rose-400">{(entry.context.noPrice * 100).toFixed(0)}¢</span>
                    </span>

                    {/* Reason */}
                    <span className="text-zinc-400 flex-1 truncate" title={entry.decision.reason}>
                      {entry.decision.reason}
                    </span>

                    {/* P&L if available */}
                    {entry.outcome?.pnl !== undefined && (
                      <span className={`w-16 text-right font-semibold ${
                        entry.outcome.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}>
                        {entry.outcome.pnl >= 0 ? '+' : ''}${entry.outcome.pnl.toFixed(2)}
                      </span>
                    )}
                  </div>

                  {/* Expanded details (thresholds, calculations) */}
                  {(entry.decision.thresholds || entry.decision.calculation) && (
                    <div className="mt-1 ml-20 text-[10px] text-zinc-600">
                      {entry.decision.calculation && (
                        <span className="mr-3">📐 {entry.decision.calculation}</span>
                      )}
                      {entry.decision.thresholds && (
                        <span>
                          🎚️ {Object.entries(entry.decision.thresholds)
                            .map(([k, v]) => `${k}=${typeof v === 'number' && v < 1 ? (v * 100).toFixed(0) + '¢' : v}`)
                            .join(', ')}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// Session Summary Card for review
interface SessionSummaryProps {
  session: SessionAudit
  onSelect: () => void
  selected?: boolean
}

export function SessionSummaryCard({ session, onSelect, selected }: SessionSummaryProps) {
  const pnlColor = session.summary.finalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
  const grade = session.aiAnalysis?.grade

  return (
    <button
      onClick={onSelect}
      className={`w-full p-3 rounded-lg border text-left transition-colors ${
        selected
          ? 'border-cyan-500/50 bg-cyan-500/10'
          : 'border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/50'
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">{session.strategy === 'MOMENTUM' ? '🚀' : '⚖️'}</span>
          <span className="font-medium text-zinc-200">{session.asset}</span>
          <span className="text-xs text-zinc-500">
            {session.strategy === 'MOMENTUM' ? 'MOM' : 'DUAL'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {grade && (
            <span className={`px-2 py-0.5 rounded text-xs font-bold ${
              grade === 'S' || grade === 'A' ? 'bg-emerald-500/20 text-emerald-400' :
              grade === 'B' || grade === 'C' ? 'bg-amber-500/20 text-amber-400' :
              'bg-rose-500/20 text-rose-400'
            }`}>
              {grade}
            </span>
          )}
          <span className={`font-mono font-semibold ${pnlColor}`}>
            {session.summary.finalPnl >= 0 ? '+' : ''}${session.summary.finalPnl.toFixed(2)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-zinc-500">
        <span>{new Date(session.startTime).toLocaleTimeString()}</span>
        <span>📥 {session.summary.totalEntries} entries</span>
        <span>🛡️ {session.summary.hedgeCount} hedges</span>
        <span className="text-emerald-400">✓ {session.summary.winningTrades}</span>
        <span className="text-rose-400">✗ {session.summary.losingTrades}</span>
      </div>
    </button>
  )
}
