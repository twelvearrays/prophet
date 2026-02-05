import { useState, useMemo, useEffect, useCallback } from "react"
import { PortfolioHeader } from "@/components/dashboard/PortfolioHeader"
import { SessionCard } from "@/components/dashboard/SessionCard"
import { SessionDetail } from "@/components/dashboard/SessionDetail"
import { StrategyRecap } from "@/components/dashboard/StrategyRecap"
import { ConfigPanel } from "@/components/dashboard/ConfigPanel"
import { AuditLog } from "@/components/dashboard/AuditLog"
import { AIReviewPrompt } from "@/components/dashboard/AIReviewPrompt"
import { LiveTradingPanel } from "@/components/dashboard/LiveTradingPanel"
import { ArbitrageMonitor } from "@/components/dashboard/ArbitrageMonitor"
import { CrossMarketMonitor } from "@/components/dashboard/CrossMarketMonitor"
import { useSimulation } from "@/hooks/useSimulation"
import { useLiveData, setPositionSize, setSelectedAssets, setMomentumWarmup } from "@/hooks/useLiveData"
import { setDualEntryPositionSize } from "@/strategies/dualEntry"
import { getDefaultPreset, type MomentumConfig } from "@/lib/configStorage"
import { getArbitrageConfig } from "@/config/useConfig"

type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP'

function App() {
  const [mode, setMode] = useState<"simulation" | "live">("live")
  const [showConfig, setShowConfig] = useState(false)
  const [showAuditLog, setShowAuditLog] = useState(false)
  const [showArbitrage, setShowArbitrage] = useState(false)
  const [isLiveTrading, setIsLiveTrading] = useState(false)
  const [positionSize, setPositionSizeState] = useState(1) // Default $1
  const [selectedAssetsState, setSelectedAssetsState] = useState<Asset[]>(['BTC']) // Default BTC only
  const [warmupSeconds, setWarmupSecondsState] = useState(60) // Default 60 seconds warmup

  // Load default momentum config on startup
  useEffect(() => {
    const loadDefault = async () => {
      const defaultPreset = await getDefaultPreset('momentum')
      if (defaultPreset) {
        const cfg = defaultPreset.config as unknown as MomentumConfig
        console.log('[CONFIG] Loading default momentum preset:', defaultPreset.name)
        if (cfg.positionSize !== undefined) {
          setPositionSizeState(cfg.positionSize)
          setPositionSize(cfg.positionSize)
          setDualEntryPositionSize(cfg.positionSize)
        }
        if (cfg.selectedAssets) {
          setSelectedAssetsState(cfg.selectedAssets as Asset[])
          setSelectedAssets(cfg.selectedAssets as Asset[])
        }
        if (cfg.warmupSeconds !== undefined) {
          setWarmupSecondsState(cfg.warmupSeconds)
          setMomentumWarmup(cfg.warmupSeconds)
        }
      }
    }
    loadDefault()
  }, [])

  // Update all strategy configs when position size changes
  const handlePositionSizeChange = useCallback((size: number) => {
    setPositionSizeState(size)
    setPositionSize(size)
    setDualEntryPositionSize(size)
  }, [])

  // Update asset filter
  const handleAssetsChange = useCallback((assets: Asset[]) => {
    setSelectedAssetsState(assets)
    setSelectedAssets(assets)
  }, [])

  // Update momentum warmup
  const handleWarmupChange = useCallback((seconds: number) => {
    setWarmupSecondsState(seconds)
    setMomentumWarmup(seconds)
  }, [])

  const simulation = useSimulation()
  const live = useLiveData()

  const data = mode === "live" ? live : simulation
  const {
    sessions,
    selectedSession,
    selectedSessionId,
    setSelectedSessionId,
    stats,
  } = data

  // Strategy from live data (simulation doesn't support it yet)
  const strategyMode = mode === "live" ? live.strategyMode : "single"
  const toggleCompareMode = mode === "live" ? live.toggleCompareMode : undefined
  const strategyStats = mode === "live" ? live.strategyStats : null

  const error = mode === "live" ? live.error : null

  // Force re-render every second to update timers and filter expired sessions
  const [, setTick] = useState(0)
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  // Filter sessions: show all sessions while market window is active
  // Only hide after the 15-minute window expires
  const activeSessions = useMemo(() => {
    const now = Date.now()
    return sessions.filter(s => s.endTime > now)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, Math.floor(Date.now() / 1000)]) // Re-evaluate every second

  // Group sessions by market for comparison view
  const sessionsByMarket = useMemo(() => {
    const groups = new Map<string, typeof activeSessions>()
    for (const session of activeSessions) {
      const existing = groups.get(session.marketId) || []
      existing.push(session)
      groups.set(session.marketId, existing)
    }
    return groups
  }, [activeSessions])

  return (
    <div className="min-h-screen bg-zinc-950">
      <PortfolioHeader stats={stats} />

      <main className="p-4 space-y-4">
        {/* Mode Toggle + Strategy Comparison Toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Mode Toggle */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMode("live")}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  mode === "live"
                    ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                    : "text-zinc-400 hover:text-zinc-300"
                }`}
              >
                Live Paper Trading
              </button>
              <button
                onClick={() => setMode("simulation")}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  mode === "simulation"
                    ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                    : "text-zinc-400 hover:text-zinc-300"
                }`}
              >
                Simulation
              </button>
            </div>

            {/* Strategy Comparison Toggle */}
            {mode === "live" && toggleCompareMode && (
              <div className="flex items-center gap-2 px-3 py-1 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
                <span className="text-xs text-zinc-500 uppercase tracking-wide">Mode:</span>
                <button
                  onClick={() => toggleCompareMode(true)}
                  className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
                    strategyMode === "compare"
                      ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                      : "text-zinc-400 hover:text-zinc-300"
                  }`}
                >
                  ⚔️ Compare
                </button>
                <button
                  onClick={() => toggleCompareMode(false)}
                  className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
                    strategyMode === "single"
                      ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                      : "text-zinc-400 hover:text-zinc-300"
                  }`}
                >
                  Single
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {mode === "live" && (
              <span className={`text-xs ${isLiveTrading ? 'text-red-400' : 'text-zinc-500'}`}>
                {isLiveTrading ? '🔴 LIVE TRADING ACTIVE' : 'Prices from Polymarket • Paper trading'}
              </span>
            )}
            <button
              onClick={() => setShowArbitrage(!showArbitrage)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-1.5 ${
                showArbitrage
                  ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                  : "bg-zinc-800 text-zinc-400 hover:text-zinc-300 border border-zinc-700"
              }`}
            >
              🔀 Arbitrage
            </button>
            <button
              onClick={() => setShowAuditLog(!showAuditLog)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-1.5 ${
                showAuditLog
                  ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                  : "bg-zinc-800 text-zinc-400 hover:text-zinc-300 border border-zinc-700"
              }`}
            >
              📋 Audit
            </button>
            <button
              onClick={() => setShowConfig(!showConfig)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-1.5 ${
                showConfig
                  ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                  : "bg-zinc-800 text-zinc-400 hover:text-zinc-300 border border-zinc-700"
              }`}
            >
              ⚙️ Config
            </button>
          </div>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm">
            {error}
            <button
              onClick={() => setMode("simulation")}
              className="ml-2 underline hover:no-underline"
            >
              Switch to simulation
            </button>
          </div>
        )}

        {/* Config Panel (Collapsible) */}
        {showConfig && (
          <div className="mb-4 grid grid-cols-12 gap-4">
            <div className="col-span-9">
              <ConfigPanel
                positionSize={positionSize}
                onPositionSizeChange={handlePositionSizeChange}
                warmupSeconds={warmupSeconds}
                onWarmupChange={handleWarmupChange}
                selectedAssets={selectedAssetsState}
                onAssetsChange={handleAssetsChange}
              />
            </div>
            <div className="col-span-3">
              <LiveTradingPanel
                onStatusChange={setIsLiveTrading}
                positionSize={positionSize}
                selectedAssets={selectedAssetsState}
                onAssetsChange={handleAssetsChange}
              />
            </div>
          </div>
        )}

        {/* Arbitrage Monitor Panel (Collapsible) */}
        {showArbitrage && (
          <div className="mb-4 space-y-4">
            {/* Type 1: Multi-Outcome Arbitrage */}
            <div className="grid grid-cols-12 gap-4">
              <div className="col-span-5">
                <ArbitrageMonitor
                  config={getArbitrageConfig()}
                  onOpportunityDetected={(opp) => {
                    console.log('[ARBITRAGE] Opportunity detected:', opp)
                  }}
                />
              </div>
              <div className="col-span-7">
                <div className="p-4 rounded-lg border border-zinc-700 bg-zinc-900/50 h-full">
                  <h3 className="text-sm font-medium text-zinc-400 mb-3">
                    <span className="text-emerald-400">Type 1:</span> Multi-Outcome Arbitrage (Frank-Wolfe)
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-3 rounded bg-zinc-800/50 border border-zinc-700/50">
                      <div className="text-xs text-amber-400 mb-2 font-medium">💰 The Opportunity</div>
                      <div className="space-y-2 text-xs text-zinc-400">
                        <p>In multi-outcome events, all outcome probabilities must sum to 1.00</p>
                        <div className="p-2 bg-zinc-900 rounded mt-2">
                          <div className="text-emerald-400 font-mono">If Σ(outcomes) {"<"} 1.00:</div>
                          <div className="text-zinc-500 ml-2">→ BUY ALL outcomes</div>
                          <div className="text-zinc-600 text-[10px] ml-2">One will win = guaranteed $1 payout</div>
                        </div>
                        <div className="p-2 bg-zinc-900 rounded">
                          <div className="text-red-400 font-mono">If Σ(outcomes) {">"} 1.00:</div>
                          <div className="text-zinc-500 ml-2">→ SELL ALL outcomes</div>
                          <div className="text-zinc-600 text-[10px] ml-2">Only pay out $1 max, keep excess</div>
                        </div>
                      </div>
                    </div>
                    <div className="p-3 rounded bg-zinc-800/50 border border-zinc-700/50">
                      <div className="text-xs text-cyan-400 mb-2 font-medium">📊 NegRisk Markets</div>
                      <div className="space-y-2 text-xs text-zinc-400">
                        <p>Polymarket uses NegRisk for multi-outcome events:</p>
                        <p>• "Who will win the election?" (5+ candidates)</p>
                        <p>• "Which team wins the championship?"</p>
                        <p>• "What price will BTC reach?"</p>
                        <div className="mt-2 p-2 bg-emerald-500/10 border border-emerald-500/20 rounded">
                          <div className="text-emerald-400 text-[10px]">More outcomes = more fee drag</div>
                          <div className="text-zinc-500 text-[10px]">5 outcomes × 2% × 2 = 20% fee overhead</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Type 2: Cross-Market Arbitrage */}
            <div className="grid grid-cols-12 gap-4">
              <div className="col-span-7">
                <CrossMarketMonitor />
              </div>
              <div className="col-span-5">
                <div className="p-4 rounded-lg border border-zinc-700 bg-zinc-900/50 h-full">
                  <h3 className="text-sm font-medium text-zinc-400 mb-3">
                    <span className="text-blue-400">Type 2:</span> Cross-Market Dependencies
                  </h3>
                  <div className="space-y-3">
                    <div className="p-3 rounded bg-zinc-800/50 border border-zinc-700/50">
                      <div className="text-xs text-blue-400 mb-2 font-medium">⏰ Temporal Dependencies</div>
                      <div className="text-xs text-zinc-400">
                        <p>"X by March" should have P ≤ "X by June"</p>
                        <p className="text-zinc-500 mt-1">If the earlier deadline has higher probability, arbitrage exists.</p>
                      </div>
                    </div>
                    <div className="p-3 rounded bg-zinc-800/50 border border-zinc-700/50">
                      <div className="text-xs text-purple-400 mb-2 font-medium">📊 Threshold Dependencies</div>
                      <div className="text-xs text-zinc-400">
                        <p>"Price {">"} $100" should have P ≤ "Price {">"} $50"</p>
                        <p className="text-zinc-500 mt-1">Reaching $100 requires first reaching $50.</p>
                      </div>
                    </div>
                    <div className="p-2 bg-amber-500/10 border border-amber-500/20 rounded">
                      <div className="text-amber-400 text-xs font-medium">Strategy</div>
                      <div className="text-zinc-500 text-[10px]">
                        When violation detected: Sell the overpriced market, buy the underpriced one.
                        Profit = price difference - fees (8% for 4 legs).
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Audit Log Panel (Collapsible) */}
        {showAuditLog && (
          <div className="mb-4 grid grid-cols-12 gap-4">
            <div className="col-span-8">
              <AuditLog maxHeight="300px" />
            </div>
            <div className="col-span-4">
              <AIReviewPrompt />
            </div>
          </div>
        )}

        {/* Main Grid */}
        <div className="grid grid-cols-12 gap-4">
          {/* Sessions List */}
          <div className="col-span-4 space-y-4">
            <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide">
              Active Sessions {mode === "live" && stats.connected && "• Live"}
              {strategyMode === "compare" && ` (${sessionsByMarket.size} markets × 2 strategies)`}
            </h2>
            {activeSessions.length === 0 ? (
              <div className="p-4 rounded-lg border border-zinc-800 bg-zinc-900/50 text-zinc-500 text-sm">
                {mode === "live"
                  ? sessions.length === 0
                    ? "Connecting to Polymarket..."
                    : "Waiting for next market window..."
                  : "Starting simulation..."}
              </div>
            ) : strategyMode === "compare" ? (
              // Comparison view: group by market
              Array.from(sessionsByMarket.entries()).map(([marketId, marketSessions]) => (
                <div key={marketId} className="space-y-2">
                  <div className="text-xs text-zinc-500 uppercase tracking-wide px-1">
                    {marketSessions[0]?.asset}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {marketSessions
                      .sort((a, b) => a.strategyType.localeCompare(b.strategyType))
                      .map((session) => (
                        <SessionCard
                          key={session.id}
                          session={session}
                          selected={session.id === selectedSessionId}
                          onClick={() => setSelectedSessionId(session.id)}
                          compact
                        />
                      ))}
                  </div>
                </div>
              ))
            ) : (
              // Single strategy view
              activeSessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  selected={session.id === selectedSessionId}
                  onClick={() => setSelectedSessionId(session.id)}
                />
              ))
            )}
          </div>

          {/* Session Detail */}
          <div className="col-span-8">
            <SessionDetail session={selectedSession} />
          </div>
        </div>

        {/* Strategy Recap Panel - Bottom */}
        {mode === "live" && (
          <StrategyRecap sessions={sessions} strategyMode={strategyMode} />
        )}

        {/* Strategy Comparison Stats - Bottom */}
        {mode === "live" && strategyMode === "compare" && strategyStats && (
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div className={`p-4 rounded-lg border ${
              strategyStats.momentum.pnl >= strategyStats.dualEntry.pnl
                ? "border-emerald-500/50 bg-emerald-500/5"
                : "border-zinc-700/50 bg-zinc-800/30"
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-lg">🚀</span>
                  <span className="text-emerald-400 font-medium">Momentum</span>
                  <span className="text-xs text-zinc-500">({strategyStats.momentum.activeSessions} active)</span>
                </div>
                <span className={`font-mono text-lg font-medium ${
                  strategyStats.momentum.pnl >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}>
                  {strategyStats.momentum.pnl >= 0 ? "+" : ""}${strategyStats.momentum.pnl.toFixed(2)}
                </span>
              </div>
              <p className="text-xs text-zinc-500 mt-2">Ride the momentum when one side crosses 65¢</p>
            </div>
            <div className={`p-4 rounded-lg border ${
              strategyStats.dualEntry.pnl > strategyStats.momentum.pnl
                ? "border-purple-500/50 bg-purple-500/5"
                : "border-zinc-700/50 bg-zinc-800/30"
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-lg">⚖️</span>
                  <span className="text-purple-400 font-medium">Dual-Entry</span>
                  <span className="text-xs text-zinc-500">({strategyStats.dualEntry.activeSessions} active)</span>
                </div>
                <span className={`font-mono text-lg font-medium ${
                  strategyStats.dualEntry.pnl >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}>
                  {strategyStats.dualEntry.pnl >= 0 ? "+" : ""}${strategyStats.dualEntry.pnl.toFixed(2)}
                </span>
              </div>
              <p className="text-xs text-zinc-500 mt-2">Profit from movement, not direction. Maker orders at 46¢ & 54¢.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
