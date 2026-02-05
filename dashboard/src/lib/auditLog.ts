/**
 * Trade Audit Log System
 *
 * Comprehensive logging of every trading decision for review and analysis.
 * Each log entry captures the full context: prices, thresholds, position state, reasoning.
 *
 * Data is stored in SQLite on the backend, not localStorage.
 */

const API_URL = 'http://localhost:3001/api'

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
  | 'INCOMPLETE_FILL_ABORT'  // BUG FIX: Abort when only one side fills
  | 'CHASE_FILTER'           // NEW: Position size reduced due to chasing spike
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
  strategy: 'MOMENTUM' | 'DUAL_ENTRY' | 'ARBITRAGE'
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
  strategy: 'MOMENTUM' | 'DUAL_ENTRY' | 'ARBITRAGE'
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

class AuditLogManager {
  private listeners: Set<(entry: AuditLogEntry) => void> = new Set()
  private pendingLogs: Array<Record<string, unknown>> = []
  private flushTimeout: ReturnType<typeof setTimeout> | null = null

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

  // Flush pending logs to backend
  private async flushLogs() {
    if (this.pendingLogs.length === 0) return

    const logsToSend = [...this.pendingLogs]
    this.pendingLogs = []

    // Send each log to backend (could batch these in future)
    for (const log of logsToSend) {
      try {
        await fetch(`${API_URL}/audit/log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(log),
        })
      } catch (e) {
        // Silently fail - audit logs are not critical
        console.debug('[AUDIT] Failed to send log to backend:', e)
      }
    }
  }

  // Schedule flush (debounced)
  private scheduleFlush() {
    if (this.flushTimeout) return

    this.flushTimeout = setTimeout(() => {
      this.flushTimeout = null
      this.flushLogs()
    }, 1000) // Flush every 1 second
  }

  // Log an event
  log(params: {
    sessionId: string
    asset: string
    strategy: 'MOMENTUM' | 'DUAL_ENTRY' | 'ARBITRAGE'
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

    // Queue for backend (don't send rawData to save bandwidth)
    this.pendingLogs.push({
      timestamp: now,
      sessionId: params.sessionId,
      asset: params.asset,
      strategy: params.strategy,
      eventType: params.eventType,
      severity: params.severity || 'info',
      yesPrice: params.yesPrice,
      noPrice: params.noPrice,
      yesLiquidity: params.yesLiquidity,
      noLiquidity: params.noLiquidity,
      timeRemainingMs,
      endTime: params.endTime,
      position: params.position,
      decision: params.decision,
      outcome: params.outcome,
    })
    this.scheduleFlush()

    // Notify listeners immediately (for UI updates)
    this.listeners.forEach(cb => cb(entry))

    return entry
  }

  // Subscribe to new entries
  subscribe(callback: (entry: AuditLogEntry) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  // Get sessions from backend
  async getSessions(): Promise<SessionAudit[]> {
    try {
      const res = await fetch(`${API_URL}/audit/sessions`)
      if (!res.ok) return []
      const data = await res.json()

      // Convert backend format to frontend format
      return data.sessions.map((s: Record<string, unknown>) => ({
        sessionId: s.session_id,
        asset: s.asset,
        strategy: s.strategy,
        marketId: s.market_id,
        startTime: s.start_time,
        endTime: s.end_time,
        summary: {
          totalEntries: s.total_entries || 0,
          totalExits: s.total_exits || 0,
          hedgeCount: s.hedge_count || 0,
          finalPnl: s.final_pnl || 0,
          peakPnl: s.peak_pnl || 0,
          troughPnl: s.trough_pnl || 0,
          winningTrades: s.winning_trades || 0,
          losingTrades: s.losing_trades || 0,
        },
        entries: [],
        aiAnalysis: s.ai_grade ? {
          grade: s.ai_grade,
          summary: s.ai_summary,
          strengths: [],
          weaknesses: [],
          suggestions: [],
          analyzedAt: s.analyzed_at,
        } : undefined,
      }))
    } catch (e) {
      console.error('[AUDIT] Failed to fetch sessions:', e)
      return []
    }
  }

  // Get session from backend
  async getSession(sessionId: string): Promise<SessionAudit | undefined> {
    try {
      const [sessionRes, entriesRes] = await Promise.all([
        fetch(`${API_URL}/audit/sessions/${sessionId}`),
        fetch(`${API_URL}/audit/sessions/${sessionId}/entries`),
      ])

      if (!sessionRes.ok) return undefined

      const s = await sessionRes.json()
      const entriesData = entriesRes.ok ? await entriesRes.json() : { entries: [] }

      // Convert entries from backend format
      const entries: AuditLogEntry[] = entriesData.entries.map((e: Record<string, unknown>) => ({
        id: e.id,
        timestamp: e.timestamp,
        sessionId: e.session_id,
        asset: e.asset,
        strategy: e.strategy,
        eventType: e.event_type,
        severity: e.severity,
        context: {
          yesPrice: e.yes_price,
          noPrice: e.no_price,
          yesLiquidity: e.yes_liquidity,
          noLiquidity: e.no_liquidity,
          timeRemainingMs: e.time_remaining_ms,
          timeRemainingFormatted: this.formatTimeRemaining(e.time_remaining_ms as number || 0),
        },
        position: e.position_side ? {
          side: e.position_side,
          shares: e.position_shares,
          avgPrice: e.position_avg_price,
          unrealizedPnl: e.position_unrealized_pnl,
        } : undefined,
        decision: {
          action: e.decision_action,
          reason: e.decision_reason,
          ...(e.decision_data ? JSON.parse(e.decision_data as string) : {}),
        },
        outcome: e.outcome_pnl !== null ? {
          fillPrice: e.outcome_fill_price,
          shares: e.outcome_shares,
          pnl: e.outcome_pnl,
        } : undefined,
      }))

      return {
        sessionId: s.session_id,
        asset: s.asset,
        strategy: s.strategy,
        marketId: s.market_id,
        startTime: s.start_time,
        endTime: s.end_time,
        summary: {
          totalEntries: s.total_entries || 0,
          totalExits: s.total_exits || 0,
          hedgeCount: s.hedge_count || 0,
          finalPnl: s.final_pnl || 0,
          peakPnl: s.peak_pnl || 0,
          troughPnl: s.trough_pnl || 0,
          winningTrades: s.winning_trades || 0,
          losingTrades: s.losing_trades || 0,
        },
        entries,
        aiAnalysis: s.ai_grade ? {
          grade: s.ai_grade,
          summary: s.ai_summary,
          strengths: [],
          weaknesses: [],
          suggestions: [],
          analyzedAt: s.analyzed_at,
        } : undefined,
      }
    } catch (e) {
      console.error('[AUDIT] Failed to fetch session:', e)
      return undefined
    }
  }

  // Export session to markdown (for AI review)
  async exportSessionToMarkdown(sessionId: string): Promise<string> {
    try {
      const res = await fetch(`${API_URL}/audit/sessions/${sessionId}/markdown`)
      if (!res.ok) return 'Session not found'
      return await res.text()
    } catch (e) {
      console.error('[AUDIT] Failed to export session:', e)
      return 'Error exporting session'
    }
  }

  // Export session to JSON
  async exportSessionToJSON(sessionId: string): Promise<string> {
    const session = await this.getSession(sessionId)
    if (!session) return '{}'
    return JSON.stringify(session, null, 2)
  }

  // Force flush any pending logs
  flush() {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout)
      this.flushTimeout = null
    }
    this.flushLogs()
  }
}

// Singleton instance
export const auditLog = new AuditLogManager()

// Helper function to log with less boilerplate
export function logAudit(
  sessionId: string,
  asset: string,
  strategy: 'MOMENTUM' | 'DUAL_ENTRY' | 'ARBITRAGE',
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
