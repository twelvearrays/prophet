/**
 * AI Review Prompt Generator
 *
 * Generates a markdown prompt that can be copied to Claude/ChatGPT
 * for analyzing trading session performance and finding improvements.
 */

import { useState, useMemo } from 'react'
import { auditLog } from '@/lib/auditLog'

interface AIReviewPromptProps {
  sessionId?: string
}

export function AIReviewPrompt({ sessionId }: AIReviewPromptProps) {
  const [copied, setCopied] = useState(false)
  const [selectedSession, setSelectedSession] = useState<string>(sessionId || '')

  const sessions = useMemo(() => auditLog.getSessions(), [])

  const generatePrompt = (id: string): string => {
    const session = auditLog.getSession(id)
    if (!session) return ''

    const markdown = auditLog.exportSessionToMarkdown(id)

    return `# Trading Session Review Request

You are an expert algorithmic trading analyst. Please review this Polymarket 15-minute crypto trading session and provide:

1. **Grade (S/A/B/C/D/F)** - Overall execution quality
2. **Summary** - 2-3 sentence overview of what happened
3. **Strengths** - What the strategy did well (bullet points)
4. **Weaknesses** - Mistakes or missed opportunities (bullet points)
5. **Suggestions** - Specific improvements for next time (bullet points)
6. **Logic Errors** - Any bugs or flawed decision logic you notice

## Strategy Context

**Momentum Strategy:**
- Enter when YES or NO crosses 65¢ (shows direction conviction)
- Scale in as price moves favorably (+3% triggers add)
- Hedge if price reverses below adaptive threshold (time-decay adjusted)
- Max 2 hedges per session
- Take profit at 95¢

**Dual-Entry Strategy:**
- Place maker orders at 46¢ and 54¢ for BOTH YES and NO
- Wait for both sides to fill (neutral position)
- Sell the LOSER when it drops 15% from entry
- Let the WINNER ride until +20% gain
- Profit comes from asymmetric exit (small loss on loser, bigger win on winner)

## Key Questions to Answer

1. Were entry/exit decisions made at optimal times?
2. Did the hedge trigger appropriately or was it too early/late?
3. Were there missed scaling opportunities?
4. Did the strategy hold through noise or panic-exit?
5. Any anomalies in the price action that should have triggered different behavior?

---

${markdown}

---

Please analyze this session thoroughly. Be specific about timestamps and price levels when identifying issues. Focus on actionable improvements.`
  }

  const handleCopy = () => {
    const prompt = generatePrompt(selectedSession)
    navigator.clipboard.writeText(prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    const prompt = generatePrompt(selectedSession)
    const blob = new Blob([prompt], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ai-review-${selectedSession.slice(0, 8)}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const selectedSessionData = selectedSession ? auditLog.getSession(selectedSession) : null

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      {/* Header */}
      <div className="p-4 border-b border-zinc-800">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xl">🤖</span>
          <h3 className="text-lg font-medium text-zinc-200">AI Review</h3>
        </div>
        <p className="text-sm text-zinc-500">
          Generate a prompt to have Claude analyze your trading session and find improvements.
        </p>
      </div>

      {/* Session Selector */}
      <div className="p-4 border-b border-zinc-800">
        <label className="block text-xs text-zinc-500 mb-2">Select Session to Review</label>
        <select
          value={selectedSession}
          onChange={e => setSelectedSession(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm"
        >
          <option value="">Choose a session...</option>
          {sessions.map(s => (
            <option key={s.sessionId} value={s.sessionId}>
              {s.asset} ({s.strategy === 'MOMENTUM' ? 'MOM' : 'DUAL'}) - {new Date(s.startTime).toLocaleString()} - {s.summary.finalPnl >= 0 ? '+' : ''}${s.summary.finalPnl.toFixed(2)}
            </option>
          ))}
        </select>
      </div>

      {/* Session Preview */}
      {selectedSessionData && (
        <div className="p-4 border-b border-zinc-800 bg-zinc-800/30">
          <div className="grid grid-cols-4 gap-4 text-center">
            <div>
              <div className="text-xs text-zinc-500">P&L</div>
              <div className={`text-lg font-mono font-bold ${
                selectedSessionData.summary.finalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}>
                {selectedSessionData.summary.finalPnl >= 0 ? '+' : ''}${selectedSessionData.summary.finalPnl.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Entries</div>
              <div className="text-lg font-mono text-zinc-200">{selectedSessionData.summary.totalEntries}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Hedges</div>
              <div className="text-lg font-mono text-zinc-200">{selectedSessionData.summary.hedgeCount}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Events</div>
              <div className="text-lg font-mono text-zinc-200">{selectedSessionData.entries.length}</div>
            </div>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="p-4 flex gap-3">
        <button
          onClick={handleCopy}
          disabled={!selectedSession}
          className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 ${
            selectedSession
              ? copied
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border border-purple-500/30'
              : 'bg-zinc-800 text-zinc-600 cursor-not-allowed border border-zinc-700'
          }`}
        >
          {copied ? (
            <>✓ Copied!</>
          ) : (
            <>📋 Copy Prompt for Claude</>
          )}
        </button>
        <button
          onClick={handleDownload}
          disabled={!selectedSession}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            selectedSession
              ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
              : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
          }`}
        >
          📄 Download
        </button>
      </div>

      {/* Instructions */}
      <div className="p-4 bg-zinc-800/30 border-t border-zinc-800">
        <h4 className="text-xs font-medium text-zinc-400 mb-2">How to use:</h4>
        <ol className="text-xs text-zinc-500 space-y-1 list-decimal list-inside">
          <li>Select a completed session to review</li>
          <li>Click "Copy Prompt for Claude"</li>
          <li>Paste into Claude.ai or another LLM</li>
          <li>Review the analysis and apply suggestions</li>
        </ol>
      </div>
    </div>
  )
}
