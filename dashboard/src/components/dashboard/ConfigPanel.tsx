/**
 * Configuration Panel
 *
 * UI for adjusting strategy parameters, restart controls, and system settings
 */

import { useState } from 'react'
import { useConfig } from '@/config/useConfig'
import { CONFIG_LABELS } from '@/config/strategyConfig'

interface ConfigSliderProps {
  configKey: string
  value: number
  onChange: (value: number) => void
  disabled?: boolean
}

function ConfigSlider({ configKey, value, onChange, disabled }: ConfigSliderProps) {
  const meta = CONFIG_LABELS[configKey]
  if (!meta) return null

  const displayValue = meta.unit === '¢' ? (value * 100).toFixed(0) :
                       meta.unit === '%' ? (value * 100).toFixed(0) :
                       value.toString()

  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <label className="text-sm text-zinc-300">{meta.label}</label>
        <span className="text-sm font-mono text-cyan-400">
          {displayValue}{meta.unit === '$' ? '' : meta.unit || ''}
          {meta.unit === '$' && <span className="text-zinc-500"> USD</span>}
        </span>
      </div>
      <input
        type="range"
        min={meta.min}
        max={meta.max}
        step={meta.step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        disabled={disabled}
        className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-cyan-500 disabled:opacity-50"
      />
      <p className="text-xs text-zinc-500">{meta.description}</p>
    </div>
  )
}

interface ConfigToggleProps {
  configKey: string
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}

function ConfigToggle({ configKey, value, onChange, disabled }: ConfigToggleProps) {
  const meta = CONFIG_LABELS[configKey]
  if (!meta) return null

  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <label className="text-sm text-zinc-300">{meta.label}</label>
        <p className="text-xs text-zinc-500">{meta.description}</p>
      </div>
      <button
        onClick={() => onChange(!value)}
        disabled={disabled}
        className={`relative w-12 h-6 rounded-full transition-colors ${
          value ? 'bg-cyan-500' : 'bg-zinc-600'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <span
          className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${
            value ? 'translate-x-6' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}

type TabType = 'momentum' | 'dualEntry' | 'system'

export function ConfigPanel() {
  const {
    config,
    isLoading,
    isSaving,
    lastSaved,
    updateMomentum,
    updateDualEntry,
    updateSystem,
    resetToDefaults,
    syncToBackend,
    restartSessions,
  } = useConfig()

  const [activeTab, setActiveTab] = useState<TabType>('momentum')
  const [isRestarting, setIsRestarting] = useState(false)

  const handleRestart = async () => {
    setIsRestarting(true)
    await syncToBackend()
    await restartSessions()
    setIsRestarting(false)
  }

  if (isLoading) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="animate-pulse text-zinc-500">Loading config...</div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      {/* Header */}
      <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Strategy Configuration</h2>
          {lastSaved && (
            <p className="text-xs text-zinc-500">
              Last saved: {lastSaved.toLocaleTimeString()}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={resetToDefaults}
            className="px-3 py-1.5 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
          >
            Reset Defaults
          </button>
          <button
            onClick={handleRestart}
            disabled={isRestarting}
            className="px-3 py-1.5 text-xs rounded bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors disabled:opacity-50"
          >
            {isRestarting ? 'Restarting...' : '↻ Restart Sessions'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-zinc-800">
        <div className="flex">
          {[
            { key: 'momentum', label: '🚀 Momentum' },
            { key: 'dualEntry', label: '⚖️ Dual-Entry' },
            { key: 'system', label: '⚙️ System' },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key as TabType)}
              className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'text-cyan-400 border-b-2 border-cyan-400 bg-zinc-800/50'
                  : 'text-zinc-400 hover:text-zinc-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="p-4 space-y-4 max-h-[500px] overflow-y-auto">
        {activeTab === 'momentum' && (
          <>
            <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Entry & Scaling</div>
            <ConfigSlider
              configKey="momentum.positionSize"
              value={config.momentum.positionSize}
              onChange={(v) => updateMomentum('positionSize', v)}
            />
            <ConfigSlider
              configKey="momentum.entryThreshold"
              value={config.momentum.entryThreshold}
              onChange={(v) => updateMomentum('entryThreshold', v)}
            />
            <ConfigSlider
              configKey="momentum.maxEntryPrice"
              value={config.momentum.maxEntryPrice}
              onChange={(v) => updateMomentum('maxEntryPrice', v)}
            />
            <ConfigSlider
              configKey="momentum.scale2Threshold"
              value={config.momentum.scale2Threshold}
              onChange={(v) => updateMomentum('scale2Threshold', v)}
            />
            <ConfigSlider
              configKey="momentum.scale3Threshold"
              value={config.momentum.scale3Threshold}
              onChange={(v) => updateMomentum('scale3Threshold', v)}
            />

            <div className="border-t border-zinc-800 pt-4 mt-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Take Profit</div>
              <ConfigToggle
                configKey="momentum.takeProfitEnabled"
                value={config.momentum.takeProfitEnabled}
                onChange={(v) => updateMomentum('takeProfitEnabled', v)}
              />
              <ConfigSlider
                configKey="momentum.takeProfitThreshold"
                value={config.momentum.takeProfitThreshold}
                onChange={(v) => updateMomentum('takeProfitThreshold', v)}
                disabled={!config.momentum.takeProfitEnabled}
              />
            </div>

            <div className="border-t border-zinc-800 pt-4 mt-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Hedge Protection</div>
              <ConfigSlider
                configKey="momentum.maxHedges"
                value={config.momentum.maxHedges}
                onChange={(v) => updateMomentum('maxHedges', v)}
              />
              <ConfigSlider
                configKey="momentum.baseHedgeTrigger"
                value={config.momentum.baseHedgeTrigger}
                onChange={(v) => updateMomentum('baseHedgeTrigger', v)}
              />
            </div>

            <div className="border-t border-zinc-800 pt-4 mt-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Execution</div>
              <ConfigSlider
                configKey="momentum.slippageBps"
                value={config.momentum.slippageBps}
                onChange={(v) => updateMomentum('slippageBps', v)}
              />
            </div>
          </>
        )}

        {activeTab === 'dualEntry' && (
          <>
            <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Order Placement</div>
            <ConfigSlider
              configKey="dualEntry.makerBidPrice"
              value={config.dualEntry.makerBidPrice}
              onChange={(v) => updateDualEntry('makerBidPrice', v)}
            />
            <ConfigSlider
              configKey="dualEntry.makerAskPrice"
              value={config.dualEntry.makerAskPrice}
              onChange={(v) => updateDualEntry('makerAskPrice', v)}
            />
            <ConfigSlider
              configKey="dualEntry.investmentPerSide"
              value={config.dualEntry.investmentPerSide}
              onChange={(v) => updateDualEntry('investmentPerSide', v)}
            />

            <div className="border-t border-zinc-800 pt-4 mt-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Exit Thresholds</div>
              <ConfigSlider
                configKey="dualEntry.loserDropPct"
                value={config.dualEntry.loserDropPct}
                onChange={(v) => updateDualEntry('loserDropPct', v)}
              />
              <ConfigSlider
                configKey="dualEntry.winnerGainPct"
                value={config.dualEntry.winnerGainPct}
                onChange={(v) => updateDualEntry('winnerGainPct', v)}
              />
            </div>
          </>
        )}

        {activeTab === 'system' && (
          <>
            <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Trading Mode</div>
            <ConfigToggle
              configKey="system.paperTrading"
              value={config.system.paperTrading}
              onChange={(v) => updateSystem('paperTrading', v)}
            />
            <div className={`p-3 rounded-lg ${config.system.paperTrading ? 'bg-cyan-500/10 border border-cyan-500/30' : 'bg-rose-500/10 border border-rose-500/30'}`}>
              <p className={`text-sm font-medium ${config.system.paperTrading ? 'text-cyan-400' : 'text-rose-400'}`}>
                {config.system.paperTrading ? '📝 Paper Trading Mode' : '💰 LIVE TRADING MODE'}
              </p>
              <p className="text-xs text-zinc-400 mt-1">
                {config.system.paperTrading
                  ? 'Simulated trades - no real money at risk'
                  : 'Real trades will be executed on Polymarket'}
              </p>
            </div>

            <div className="border-t border-zinc-800 pt-4 mt-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Session Management</div>
              <ConfigToggle
                configKey="system.autoRestartOnNewMarket"
                value={config.system.autoRestartOnNewMarket}
                onChange={(v) => updateSystem('autoRestartOnNewMarket', v)}
              />
            </div>

            <div className="border-t border-zinc-800 pt-4 mt-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Portfolio</div>
              <ConfigSlider
                configKey="system.portfolioValue"
                value={config.system.portfolioValue}
                onChange={(v) => updateSystem('portfolioValue', v)}
              />
            </div>

            <div className="border-t border-zinc-800 pt-4 mt-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Actions</div>
              <div className="space-y-2">
                <button
                  onClick={handleRestart}
                  disabled={isRestarting}
                  className="w-full px-4 py-2 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors disabled:opacity-50"
                >
                  {isRestarting ? 'Restarting...' : '↻ Restart All Sessions'}
                </button>
                <button
                  onClick={syncToBackend}
                  disabled={isSaving}
                  className="w-full px-4 py-2 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors disabled:opacity-50"
                >
                  {isSaving ? 'Syncing...' : '⬆ Sync Config to Backend'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
