/**
 * Configuration Hook
 *
 * Manages strategy configuration with persistence to localStorage
 * and sync to backend for live updates
 */

import { useState, useEffect, useCallback } from 'react'
import {
  StrategyConfigState,
  DEFAULT_CONFIG,
  MomentumConfig,
  DualEntryConfig,
  ArbitrageConfig,
  SystemConfig,
} from './strategyConfig'

const STORAGE_KEY = 'polymarket-strategy-config'
const API_URL = 'http://localhost:3001/api'

// Deep merge helper
function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target }
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] as object, source[key] as object) as T[typeof key]
    } else if (source[key] !== undefined) {
      result[key] = source[key] as T[typeof key]
    }
  }
  return result
}

export function useConfig() {
  const [config, setConfigState] = useState<StrategyConfigState>(DEFAULT_CONFIG)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)

  // Load config from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        // Merge with defaults to handle new fields
        setConfigState(deepMerge(DEFAULT_CONFIG, parsed))
      }
    } catch (e) {
      console.error('Failed to load config from localStorage:', e)
    }
    setIsLoading(false)
  }, [])

  // Save config to localStorage whenever it changes
  const saveConfig = useCallback((newConfig: StrategyConfigState) => {
    setConfigState(newConfig)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig))
      setLastSaved(new Date())
    } catch (e) {
      console.error('Failed to save config to localStorage:', e)
    }
  }, [])

  // Update a single momentum config value
  const updateMomentum = useCallback(<K extends keyof MomentumConfig>(
    key: K,
    value: MomentumConfig[K]
  ) => {
    setConfigState(prev => {
      const newConfig = {
        ...prev,
        momentum: { ...prev.momentum, [key]: value }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig))
      setLastSaved(new Date())
      return newConfig
    })
  }, [])

  // Update a single dual-entry config value
  const updateDualEntry = useCallback(<K extends keyof DualEntryConfig>(
    key: K,
    value: DualEntryConfig[K]
  ) => {
    setConfigState(prev => {
      const newConfig = {
        ...prev,
        dualEntry: { ...prev.dualEntry, [key]: value }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig))
      setLastSaved(new Date())
      return newConfig
    })
  }, [])

  // Update a single arbitrage config value
  const updateArbitrage = useCallback(<K extends keyof ArbitrageConfig>(
    key: K,
    value: ArbitrageConfig[K]
  ) => {
    setConfigState(prev => {
      const newConfig = {
        ...prev,
        arbitrage: { ...prev.arbitrage, [key]: value }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig))
      setLastSaved(new Date())
      return newConfig
    })
  }, [])

  // Update a single system config value
  const updateSystem = useCallback(<K extends keyof SystemConfig>(
    key: K,
    value: SystemConfig[K]
  ) => {
    setConfigState(prev => {
      const newConfig = {
        ...prev,
        system: { ...prev.system, [key]: value }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig))
      setLastSaved(new Date())
      return newConfig
    })
  }, [])

  // Reset to defaults
  const resetToDefaults = useCallback(() => {
    saveConfig(DEFAULT_CONFIG)
  }, [saveConfig])

  // Sync config to backend (for live strategy updates)
  const syncToBackend = useCallback(async () => {
    setIsSaving(true)
    try {
      const response = await fetch(`${API_URL}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (!response.ok) throw new Error('Failed to sync config')
      console.log('[CONFIG] Synced to backend')
      return true
    } catch (e) {
      console.error('Failed to sync config to backend:', e)
      return false
    } finally {
      setIsSaving(false)
    }
  }, [config])

  // Restart sessions via backend
  const restartSessions = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/restart`, {
        method: 'POST',
      })
      if (!response.ok) throw new Error('Failed to restart')
      console.log('[CONFIG] Sessions restarted')
      return true
    } catch (e) {
      console.error('Failed to restart sessions:', e)
      return false
    }
  }, [])

  return {
    config,
    isLoading,
    isSaving,
    lastSaved,
    updateMomentum,
    updateDualEntry,
    updateArbitrage,
    updateSystem,
    resetToDefaults,
    syncToBackend,
    restartSessions,
  }
}

// Export singleton config getter for use in strategy logic
let currentConfig: StrategyConfigState = DEFAULT_CONFIG

export function setGlobalConfig(config: StrategyConfigState) {
  currentConfig = config
}

export function getMomentumConfig(): MomentumConfig {
  return currentConfig.momentum
}

export function getDualEntryConfig(): DualEntryConfig {
  return currentConfig.dualEntry
}

export function getArbitrageConfig(): ArbitrageConfig {
  return currentConfig.arbitrage
}

export function getSystemConfig(): SystemConfig {
  return currentConfig.system
}
