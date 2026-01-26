/**
 * Configuration Panel
 *
 * UI for adjusting strategy parameters, restart controls, and system settings
 */

import { useState, useEffect } from 'react'
import { useConfig } from '@/config/useConfig'
import { CONFIG_LABELS } from '@/config/strategyConfig'
import {
  getPresetsByStrategy,
  savePreset,
  deletePreset,
  getPreset,
  setDefaultPreset,
  getDefaultPreset,
  type StrategyPreset,
  type StrategyType,
  type MomentumConfig,
  type DualEntryConfig,
} from '@/lib/configStorage'

type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP'

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

type TabType = 'momentum' | 'dualEntry' | 'system' | 'presets'

interface ConfigPanelProps {
  positionSize?: number
  onPositionSizeChange?: (size: number) => void
  warmupSeconds?: number
  onWarmupChange?: (seconds: number) => void
  selectedAssets?: Asset[]
  onAssetsChange?: (assets: Asset[]) => void
}

export function ConfigPanel({
  positionSize = 1,
  onPositionSizeChange,
  warmupSeconds = 60,
  onWarmupChange,
  selectedAssets = ['BTC'] as Asset[],
  onAssetsChange,
}: ConfigPanelProps) {
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

  // Per-strategy preset state
  const [momentumPresets, setMomentumPresets] = useState<StrategyPreset[]>([])
  const [dualEntryPresets, setDualEntryPresets] = useState<StrategyPreset[]>([])
  const [newPresetName, setNewPresetName] = useState('')
  const [presetStrategy, setPresetStrategy] = useState<StrategyType>('momentum')
  const [selectedPresetName, setSelectedPresetName] = useState<string | null>(null)

  // Load presets for both strategies on mount
  useEffect(() => {
    const loadAllPresets = async () => {
      const [momentum, dualEntry] = await Promise.all([
        getPresetsByStrategy('momentum'),
        getPresetsByStrategy('dualEntry'),
      ])
      setMomentumPresets(momentum)
      setDualEntryPresets(dualEntry)
    }
    loadAllPresets()
  }, [])

  // Refresh presets for a specific strategy
  const refreshPresets = async (strategy: StrategyType) => {
    const presets = await getPresetsByStrategy(strategy)
    if (strategy === 'momentum') {
      setMomentumPresets(presets)
    } else {
      setDualEntryPresets(presets)
    }
  }

  // Load default presets on mount
  useEffect(() => {
    const loadDefaults = async () => {
      // Load momentum default
      const momentumDefault = await getDefaultPreset('momentum')
      if (momentumDefault) {
        const cfg = momentumDefault.config as unknown as MomentumConfig
        if (cfg.positionSize !== undefined) onPositionSizeChange?.(cfg.positionSize)
        if (cfg.warmupSeconds !== undefined) onWarmupChange?.(cfg.warmupSeconds)
        if (cfg.selectedAssets) onAssetsChange?.(cfg.selectedAssets as Asset[])
      }
    }
    loadDefaults()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRestart = async () => {
    setIsRestarting(true)
    await syncToBackend()
    await restartSessions()
    setIsRestarting(false)
  }

  const handleSavePreset = async () => {
    if (!newPresetName.trim()) return

    const configData: MomentumConfig | DualEntryConfig = presetStrategy === 'momentum'
      ? {
          positionSize,
          warmupSeconds,
          selectedAssets,
          takeProfitEnabled: config.momentum.takeProfitEnabled,
          takeProfitThreshold: config.momentum.takeProfitThreshold,
          maxHedges: config.momentum.maxHedges,
        }
      : {
          positionSize,
          selectedAssets,
          loserDropPct: config.dualEntry.loserDropPct,
          winnerGainPct: config.dualEntry.winnerGainPct,
        }

    const preset = await savePreset(presetStrategy, newPresetName.trim(), configData)
    await refreshPresets(presetStrategy)
    setNewPresetName('')
    if (preset) {
      setSelectedPresetName(preset.name)
    }
  }

  const handleLoadPreset = async (strategy: StrategyType, name: string) => {
    const preset = await getPreset(strategy, name)
    if (preset) {
      const cfg = preset.config as unknown as MomentumConfig | DualEntryConfig
      if ('positionSize' in cfg) onPositionSizeChange?.(cfg.positionSize)
      if ('warmupSeconds' in cfg) onWarmupChange?.((cfg as MomentumConfig).warmupSeconds)
      if ('selectedAssets' in cfg) onAssetsChange?.(cfg.selectedAssets as Asset[])
      setSelectedPresetName(name)
    }
  }

  const handleDeletePreset = async (strategy: StrategyType, name: string) => {
    await deletePreset(strategy, name)
    await refreshPresets(strategy)
    if (selectedPresetName === name) {
      setSelectedPresetName(null)
    }
  }

  const handleSetDefault = async (strategy: StrategyType, name: string, isCurrentDefault: boolean) => {
    if (isCurrentDefault) {
      // Clear the default by saving without isDefault (API clears on set)
      const preset = await getPreset(strategy, name)
      if (preset) {
        await savePreset(strategy, name, preset.config as unknown as MomentumConfig | DualEntryConfig, false)
      }
    } else {
      await setDefaultPreset(strategy, name)
    }
    await refreshPresets(strategy)
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
            { key: 'presets', label: '💾 Presets' },
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
            {/* Live Trading Config */}
            <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Position & Timing</div>

            {/* Position Size Control */}
            <div className="space-y-1 mb-4">
              <div className="flex justify-between items-center">
                <label className="text-sm text-zinc-300">Position Size (per side)</label>
                <span className="text-sm font-mono text-cyan-400">${positionSize}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onPositionSizeChange?.(Math.max(1, positionSize - 5))}
                  className="px-2 py-1 text-xs font-medium rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                >
                  -5
                </button>
                <button
                  onClick={() => onPositionSizeChange?.(Math.max(1, positionSize - 1))}
                  className="px-2 py-1 text-xs font-medium rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                >
                  -1
                </button>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={positionSize}
                  onChange={(e) => onPositionSizeChange?.(parseInt(e.target.value))}
                  className="flex-1 h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                />
                <button
                  onClick={() => onPositionSizeChange?.(Math.min(100, positionSize + 1))}
                  className="px-2 py-1 text-xs font-medium rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                >
                  +1
                </button>
                <button
                  onClick={() => onPositionSizeChange?.(Math.min(100, positionSize + 5))}
                  className="px-2 py-1 text-xs font-medium rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                >
                  +5
                </button>
              </div>
              <p className="text-xs text-zinc-500">Total per trade: ${positionSize * 2} (${positionSize} YES + ${positionSize} NO)</p>
            </div>

            {/* Warmup Control */}
            <div className="space-y-1 mb-4">
              <div className="flex justify-between items-center">
                <label className="text-sm text-zinc-300">Warmup Time</label>
                <span className="text-sm font-mono text-cyan-400">{warmupSeconds}s ({(warmupSeconds / 60).toFixed(1)} min)</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onWarmupChange?.(Math.max(0, warmupSeconds - 60))}
                  className="px-2 py-1 text-xs font-medium rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                >
                  -1m
                </button>
                <button
                  onClick={() => onWarmupChange?.(Math.max(0, warmupSeconds - 10))}
                  className="px-2 py-1 text-xs font-medium rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                >
                  -10s
                </button>
                <input
                  type="range"
                  min={0}
                  max={720}
                  step={10}
                  value={warmupSeconds}
                  onChange={(e) => onWarmupChange?.(parseInt(e.target.value))}
                  className="flex-1 h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                />
                <button
                  onClick={() => onWarmupChange?.(Math.min(720, warmupSeconds + 10))}
                  className="px-2 py-1 text-xs font-medium rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                >
                  +10s
                </button>
                <button
                  onClick={() => onWarmupChange?.(Math.min(720, warmupSeconds + 60))}
                  className="px-2 py-1 text-xs font-medium rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                >
                  +1m
                </button>
              </div>
              <p className="text-xs text-zinc-500">Wait before first momentum trade (0 = no warmup, max 12 min)</p>
            </div>

            <div className="border-t border-zinc-800 pt-4 mt-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Entry & Scaling</div>
            </div>
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

        {activeTab === 'presets' && (
          <>
            {/* Save Current Config */}
            <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Save Preset</div>
            <div className="flex gap-2 mb-2">
              <select
                value={presetStrategy}
                onChange={(e) => setPresetStrategy(e.target.value as StrategyType)}
                className="px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:border-cyan-500"
              >
                <option value="momentum">🚀 Momentum</option>
                <option value="dualEntry">⚖️ Dual-Entry</option>
              </select>
              <input
                type="text"
                value={newPresetName}
                onChange={(e) => setNewPresetName(e.target.value)}
                placeholder="Enter preset name..."
                className="flex-1 px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-cyan-500"
              />
              <button
                onClick={handleSavePreset}
                disabled={!newPresetName.trim()}
                className="px-4 py-2 text-sm rounded bg-cyan-600 hover:bg-cyan-500 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Save
              </button>
            </div>

            {/* Current Config Summary */}
            <div className="p-3 bg-zinc-800/50 rounded border border-zinc-700/50 mb-4">
              <p className="text-xs text-zinc-500 mb-2">Current Settings (will be saved):</p>
              <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                <div>
                  <span className="text-zinc-500">Size:</span>
                  <span className="text-cyan-400 ml-1">${positionSize}</span>
                </div>
                <div>
                  <span className="text-zinc-500">Warmup:</span>
                  <span className="text-cyan-400 ml-1">{warmupSeconds}s</span>
                </div>
                <div>
                  <span className="text-zinc-500">Assets:</span>
                  <span className="text-cyan-400 ml-1">{selectedAssets.join(', ')}</span>
                </div>
              </div>
            </div>

            {/* Momentum Presets */}
            <div className="border-t border-zinc-800 pt-4 mt-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">🚀 Momentum Presets</div>
              {momentumPresets.length === 0 ? (
                <p className="text-sm text-zinc-500 text-center py-2">No momentum presets saved</p>
              ) : (
                <div className="space-y-2">
                  {momentumPresets.map((preset) => {
                    const cfg = preset.config as unknown as MomentumConfig
                    return (
                      <div
                        key={preset.name}
                        className={`p-3 rounded border transition-colors ${
                          selectedPresetName === preset.name
                            ? 'bg-cyan-500/10 border-cyan-500/30'
                            : 'bg-zinc-800/50 border-zinc-700/50 hover:border-zinc-600'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-zinc-200">{preset.name}</span>
                            {preset.isDefault && (
                              <span className="px-1.5 py-0.5 text-xs rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                DEFAULT
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-zinc-500">
                            {preset.updatedAt ? new Date(preset.updatedAt).toLocaleDateString() : ''}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-xs font-mono mb-3">
                          <div>
                            <span className="text-zinc-500">Size:</span>
                            <span className="text-zinc-300 ml-1">${cfg.positionSize}</span>
                          </div>
                          <div>
                            <span className="text-zinc-500">Warmup:</span>
                            <span className="text-zinc-300 ml-1">{cfg.warmupSeconds}s</span>
                          </div>
                          <div>
                            <span className="text-zinc-500">Assets:</span>
                            <span className="text-zinc-300 ml-1">{cfg.selectedAssets?.join(', ') || '-'}</span>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleLoadPreset('momentum', preset.name)}
                            className="flex-1 px-2 py-1 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
                          >
                            Load
                          </button>
                          <button
                            onClick={() => handleSetDefault('momentum', preset.name, preset.isDefault)}
                            className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                              preset.isDefault
                                ? 'bg-amber-600 hover:bg-amber-500 text-white'
                                : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300'
                            }`}
                          >
                            {preset.isDefault ? 'Unset Default' : 'Set as Default'}
                          </button>
                          <button
                            onClick={() => handleDeletePreset('momentum', preset.name)}
                            className="px-2 py-1 text-xs rounded bg-rose-600/20 hover:bg-rose-600/30 text-rose-400 border border-rose-600/30 transition-colors"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Dual-Entry Presets */}
            <div className="border-t border-zinc-800 pt-4 mt-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">⚖️ Dual-Entry Presets</div>
              {dualEntryPresets.length === 0 ? (
                <p className="text-sm text-zinc-500 text-center py-2">No dual-entry presets saved</p>
              ) : (
                <div className="space-y-2">
                  {dualEntryPresets.map((preset) => {
                    const cfg = preset.config as unknown as DualEntryConfig
                    return (
                      <div
                        key={preset.name}
                        className={`p-3 rounded border transition-colors ${
                          selectedPresetName === preset.name
                            ? 'bg-cyan-500/10 border-cyan-500/30'
                            : 'bg-zinc-800/50 border-zinc-700/50 hover:border-zinc-600'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-zinc-200">{preset.name}</span>
                            {preset.isDefault && (
                              <span className="px-1.5 py-0.5 text-xs rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                DEFAULT
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-zinc-500">
                            {preset.updatedAt ? new Date(preset.updatedAt).toLocaleDateString() : ''}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-xs font-mono mb-3">
                          <div>
                            <span className="text-zinc-500">Size:</span>
                            <span className="text-zinc-300 ml-1">${cfg.positionSize}</span>
                          </div>
                          <div>
                            <span className="text-zinc-500">Exit:</span>
                            <span className="text-zinc-300 ml-1">{((cfg.loserDropPct || 0) * 100).toFixed(0)}%</span>
                          </div>
                          <div>
                            <span className="text-zinc-500">Assets:</span>
                            <span className="text-zinc-300 ml-1">{cfg.selectedAssets?.join(', ') || '-'}</span>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleLoadPreset('dualEntry', preset.name)}
                            className="flex-1 px-2 py-1 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
                          >
                            Load
                          </button>
                          <button
                            onClick={() => handleSetDefault('dualEntry', preset.name, preset.isDefault)}
                            className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                              preset.isDefault
                                ? 'bg-amber-600 hover:bg-amber-500 text-white'
                                : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300'
                            }`}
                          >
                            {preset.isDefault ? 'Unset Default' : 'Set as Default'}
                          </button>
                          <button
                            onClick={() => handleDeletePreset('dualEntry', preset.name)}
                            className="px-2 py-1 text-xs rounded bg-rose-600/20 hover:bg-rose-600/30 text-rose-400 border border-rose-600/30 transition-colors"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
