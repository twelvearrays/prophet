/**
 * Trade Audit Log System
 *
 * Comprehensive logging of every trading decision for review and analysis.
 * Each log entry captures the full context: prices, thresholds, position state, reasoning.
 */

export type AuditEventType =
  | 'SESSION_START'
  | 'SESSION_END'
  | 'PRICE_UPDATE'
  | 'ENTRY_SIGNAL'
  | 'ENTRY_SKIP'
  | 'ENTRY_FILL'
  | 'SCALE_SIGNAL'
  | 'SCALE_FILL'
  | 'HEDGE_SIGNAL'
  | 'HEDGE_SKIP'
  | 'HEDGE_FILL'
  | 'TAKE_PROFIT'
  | 'LOSER_EXIT'
  | 'WINNER_EXIT'
  | 'FORCE_EXIT'
  | 'MAKER_ORDER_PLACED'
  | 'MAKER_ORDER_FILLED'
  | 'MAKER_ORDER_CANCELLED'
  | 'CONFIG_CHANGE'
  | 'ERROR'
  // Order lifecycle events
  | 'ORDER_CANCELLED'
  | 'ORDER_FILLED'
  | 'ORDER_CONFIRMING'
  // Execution events
  | 'ENTER_EXECUTED'
  | 'SCALE_EXECUTED'
  | 'HEDGE_EXECUTED'
  | 'CLOSE_EXECUTED'

export type AuditSeverity = 'info' | 'action' | 'warning' | 'error' | 'profit' | 'loss'

export interface AuditLogEntry {
  id: string
  timestamp: number
  sessionId: string
  asset: string
  strategy: 'MOMENTUM' | 'DUAL_ENTRY'
  eventType: AuditEventType
  severity: AuditSeverity

  // Market context at time of event
  context: {
    yesPrice: number
    noPrice: number
    yesLiquidity?: number
    noLiquidity?: number
    timeRemainingMs: number
    timeRemainingFormatted: string
  }

  // Position state
  position?: {
    side?: 'YES' | 'NO'
    shares?: number
    avgPrice?: number
    entryPrice?: number
    unrealizedPnl?: number
    hedgeCount?: number
  }

  // Decision details
  decision: {
    action: string
    reason: string
    thresholds?: Record<string, number>
    calculation?: string
    // Order-related fields
    orderType?: string
    orderSide?: string
    triggerPrice?: number
    fillPrice?: number
    shares?: number
    slippageBps?: number
    currentPrice?: number
    confirmationTicks?: number
    requiredTicks?: number
    // Execution details
    execution?: {
      side: string
      shares: number
      triggerPrice: number
      fillPrice: number
      slippageBps: number
    }
  }

  // Outcome (for fills)
  outcome?: {
    fillPrice?: number
    shares?: number
    cost?: number
    pnl?: number
    fees?: number
  }

  // Raw data for debugging
  rawData?: Record<string, unknown>
}

export interface SessionAudit {
  sessionId: string
  asset: string
  strategy: 'MOMENTUM' | 'DUAL_ENTRY'
  marketId: string
  startTime: number
  endTime: number

  // Summary stats
  summary: {
    totalEntries: number
    totalExits: number
    hedgeCount: number
    finalPnl: number
    peakPnl: number
    troughPnl: number
    winningTrades: number
    losingTrades: number
  }

  // All log entries for this session
  entries: AuditLogEntry[]

  // AI analysis (filled in later)
  aiAnalysis?: {
    grade: 'S' | 'A' | 'B' | 'C' | 'D' | 'F'
    summary: string
    strengths: string[]
    weaknesses: string[]
    suggestions: string[]
    analyzedAt: number
  }
}

// In-memory storage (persisted to localStorage)
const STORAGE_KEY = 'polymarket-audit-log'
const MAX_ENTRIES = 5000 // Keep last 5000 entries
const MAX_SESSIONS = 100 // Keep last 100 sessions

class AuditLogManager {
  private entries: AuditLogEntry[] = []
  private sessions: Map<string, SessionAudit> = new Map()
  private listeners: Set<(entry: AuditLogEntry) => void> = new Set()

  constructor() {
    this.loadFromStorage()
  }

  private loadFromStorage() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const data = JSON.parse(stored)
        this.entries = data.entries || []
        this.sessions = new Map(Object.entries(data.sessions || {}))
      }
    } catch (e) {
      console.error('[AUDIT] Failed to load from storage:', e)
    }
  }

  private saveToStorage() {
    try {
      // Trim to max size
      if (this.entries.length > MAX_ENTRIES) {
        this.entries = this.entries.slice(-MAX_ENTRIES)
      }

      // Trim sessions
      if (this.sessions.size > MAX_SESSIONS) {
        const sortedSessions = [...this.sessions.entries()]
          .sort((a, b) => b[1].startTime - a[1].startTime)
          .slice(0, MAX_SESSIONS)
        this.sessions = new Map(sortedSessions)
      }

      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        entries: this.entries,
        sessions: Object.fromEntries(this.sessions),
      }))
    } catch (e) {
      console.error('[AUDIT] Failed to save to storage:', e)
    }
  }

  // Generate unique ID
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  }

  // Format time remaining
  private formatTimeRemaining(ms: number): string {
    if (ms <= 0) return '0:00'
    const totalSec = Math.floor(ms / 1000)
    const min = Math.floor(totalSec / 60)
    const sec = totalSec % 60
    return `${min}:${sec.toString().padStart(2, '0')}`
  }

  // Deduplication: track recent events to prevent double-logging from REST + WebSocket
  private recentEvents: Map<string, number> = new Map()
  private readonly DEDUP_WINDOW_MS = 500 // Ignore duplicate events within 500ms

  private isDuplicate(sessionId: string, eventType: AuditEventType, action: string): boolean {
    const key = `${sessionId}:${eventType}:${action}`
    const lastTime = this.recentEvents.get(key)
    const now = Date.now()

    if (lastTime && now - lastTime < this.DEDUP_WINDOW_MS) {
      return true // Duplicate
    }

    this.recentEvents.set(key, now)

    // Clean up old entries periodically
    if (this.recentEvents.size > 100) {
      const cutoff = now - this.DEDUP_WINDOW_MS * 2
      for (const [k, t] of this.recentEvents.entries()) {
        if (t < cutoff) this.recentEvents.delete(k)
      }
    }

    return false
  }

  // Log an event
  log(params: {
    sessionId: string
    asset: string
    strategy: 'MOMENTUM' | 'DUAL_ENTRY'
    eventType: AuditEventType
    severity?: AuditSeverity
    yesPrice: number
    noPrice: number
    yesLiquidity?: number
    noLiquidity?: number
    endTime: number
    position?: AuditLogEntry['position']
    decision: AuditLogEntry['decision']
    outcome?: AuditLogEntry['outcome']
    rawData?: Record<string, unknown>
  }): AuditLogEntry | null {
    // Deduplicate events that arrive from both REST and WebSocket
    if (this.isDuplicate(params.sessionId, params.eventType, params.decision.action)) {
      return null
    }

    const now = Date.now()
    const timeRemainingMs = params.endTime - now

    const entry: AuditLogEntry = {
      id: this.generateId(),
      timestamp: now,
      sessionId: params.sessionId,
      asset: params.asset,
      strategy: params.strategy,
      eventType: params.eventType,
      severity: params.severity || 'info',
      context: {
        yesPrice: params.yesPrice,
        noPrice: params.noPrice,
        yesLiquidity: params.yesLiquidity,
        noLiquidity: params.noLiquidity,
        timeRemainingMs,
        timeRemainingFormatted: this.formatTimeRemaining(timeRemainingMs),
      },
      position: params.position,
      decision: params.decision,
      outcome: params.outcome,
      rawData: params.rawData,
    }

    this.entries.push(entry)

    // Update session
    let session = this.sessions.get(params.sessionId)
    if (!session) {
      session = {
        sessionId: params.sessionId,
        asset: params.asset,
        strategy: params.strategy,
        marketId: params.sessionId.replace(/-mom$|-dual$/, ''),
        startTime: now,
        endTime: params.endTime,
        summary: {
          totalEntries: 0,
          totalExits: 0,
          hedgeCount: 0,
          finalPnl: 0,
          peakPnl: 0,
          troughPnl: 0,
          winningTrades: 0,
          losingTrades: 0,
        },
        entries: [],
      }
      this.sessions.set(params.sessionId, session)
    }
    session.entries.push(entry)

    // Update summary based on event type
    if (params.eventType === 'ENTRY_FILL' || params.eventType === 'MAKER_ORDER_FILLED') {
      session.summary.totalEntries++
    }
    if (params.eventType === 'HEDGE_FILL') {
      session.summary.hedgeCount++
    }
    if (params.eventType === 'TAKE_PROFIT' || params.eventType === 'LOSER_EXIT' ||
        params.eventType === 'WINNER_EXIT' || params.eventType === 'FORCE_EXIT') {
      session.summary.totalExits++
      if (params.outcome?.pnl !== undefined) {
        session.summary.finalPnl = params.outcome.pnl
        if (params.outcome.pnl > 0) session.summary.winningTrades++
        else if (params.outcome.pnl < 0) session.summary.losingTrades++
        session.summary.peakPnl = Math.max(session.summary.peakPnl, params.outcome.pnl)
        session.summary.troughPnl = Math.min(session.summary.troughPnl, params.outcome.pnl)
      }
    }

    // Notify listeners
    this.listeners.forEach(cb => cb(entry))

    // Save periodically (every 10 entries)
    if (this.entries.length % 10 === 0) {
      this.saveToStorage()
    }

    return entry
  }

  // Subscribe to new entries
  subscribe(callback: (entry: AuditLogEntry) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  // Get all entries
  getEntries(filter?: {
    sessionId?: string
    asset?: string
    strategy?: 'MOMENTUM' | 'DUAL_ENTRY'
    eventTypes?: AuditEventType[]
    severity?: AuditSeverity[]
    since?: number
  }): AuditLogEntry[] {
    let result = this.entries

    if (filter?.sessionId) {
      result = result.filter(e => e.sessionId === filter.sessionId)
    }
    if (filter?.asset) {
      result = result.filter(e => e.asset === filter.asset)
    }
    if (filter?.strategy) {
      result = result.filter(e => e.strategy === filter.strategy)
    }
    if (filter?.eventTypes?.length) {
      result = result.filter(e => filter.eventTypes!.includes(e.eventType))
    }
    if (filter?.severity?.length) {
      result = result.filter(e => filter.severity!.includes(e.severity))
    }
    if (filter?.since !== undefined) {
      const since = filter.since
      result = result.filter(e => e.timestamp >= since)
    }

    return result
  }

  // Get session audit
  getSession(sessionId: string): SessionAudit | undefined {
    return this.sessions.get(sessionId)
  }

  // Get all sessions
  getSessions(): SessionAudit[] {
    return [...this.sessions.values()].sort((a, b) => b.startTime - a.startTime)
  }

  // Export session to markdown (for AI review)
  exportSessionToMarkdown(sessionId: string): string {
    const session = this.sessions.get(sessionId)
    if (!session) return 'Session not found'

    const lines: string[] = [
      `# Trade Audit: ${session.asset} (${session.strategy})`,
      '',
      `**Session ID:** ${session.sessionId}`,
      `**Start:** ${new Date(session.startTime).toLocaleString()}`,
      `**End:** ${new Date(session.endTime).toLocaleString()}`,
      '',
      '## Summary',
      `- Total Entries: ${session.summary.totalEntries}`,
      `- Total Exits: ${session.summary.totalExits}`,
      `- Hedges: ${session.summary.hedgeCount}`,
      `- Final P&L: $${session.summary.finalPnl.toFixed(2)}`,
      `- Peak P&L: $${session.summary.peakPnl.toFixed(2)}`,
      `- Trough P&L: $${session.summary.troughPnl.toFixed(2)}`,
      `- Winning Trades: ${session.summary.winningTrades}`,
      `- Losing Trades: ${session.summary.losingTrades}`,
      '',
      '## Event Log',
      '',
    ]

    for (const entry of session.entries) {
      const time = new Date(entry.timestamp).toLocaleTimeString()
      const remaining = entry.context.timeRemainingFormatted

      lines.push(`### ${time} [${remaining} left] - ${entry.eventType}`)
      lines.push('')
      lines.push(`**Severity:** ${entry.severity}`)
      lines.push(`**Prices:** YES=${(entry.context.yesPrice * 100).toFixed(1)}¢, NO=${(entry.context.noPrice * 100).toFixed(1)}¢`)

      if (entry.position) {
        lines.push(`**Position:** ${entry.position.side || 'None'} ${entry.position.shares?.toFixed(1) || 0} shares @ ${((entry.position.avgPrice || 0) * 100).toFixed(1)}¢`)
      }

      lines.push(`**Action:** ${entry.decision.action}`)
      lines.push(`**Reason:** ${entry.decision.reason}`)

      if (entry.decision.thresholds) {
        lines.push(`**Thresholds:** ${JSON.stringify(entry.decision.thresholds)}`)
      }

      if (entry.outcome) {
        lines.push(`**Outcome:** Fill @ ${((entry.outcome.fillPrice || 0) * 100).toFixed(1)}¢, P&L: $${(entry.outcome.pnl || 0).toFixed(2)}`)
      }

      lines.push('')
    }

    return lines.join('\n')
  }

  // Export session to JSON
  exportSessionToJSON(sessionId: string): string {
    const session = this.sessions.get(sessionId)
    if (!session) return '{}'
    return JSON.stringify(session, null, 2)
  }

  // Clear all logs
  clear() {
    this.entries = []
    this.sessions.clear()
    localStorage.removeItem(STORAGE_KEY)
  }

  // Force save
  save() {
    this.saveToStorage()
  }
}

// Singleton instance
export const auditLog = new AuditLogManager()

// Helper function to log with less boilerplate
export function logAudit(
  sessionId: string,
  asset: string,
  strategy: 'MOMENTUM' | 'DUAL_ENTRY',
  eventType: AuditEventType,
  tick: { yesPrice: number; noPrice: number; yesLiquidity?: number; noLiquidity?: number },
  endTime: number,
  decision: AuditLogEntry['decision'],
  options?: {
    severity?: AuditSeverity
    position?: AuditLogEntry['position']
    outcome?: AuditLogEntry['outcome']
    rawData?: Record<string, unknown>
  }
): AuditLogEntry | null {
  return auditLog.log({
    sessionId,
    asset,
    strategy,
    eventType,
    severity: options?.severity,
    yesPrice: tick.yesPrice,
    noPrice: tick.noPrice,
    yesLiquidity: tick.yesLiquidity,
    noLiquidity: tick.noLiquidity,
    endTime,
    position: options?.position,
    decision,
    outcome: options?.outcome,
    rawData: options?.rawData,
  })
}
