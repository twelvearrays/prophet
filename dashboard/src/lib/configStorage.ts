/**
 * Configuration Storage Service
 *
 * Saves/loads trading configurations via backend API (SQLite)
 * Supports per-strategy named presets with isDefault flag
 */

const API_URL = 'http://localhost:3001/api'

export type StrategyType = 'momentum' | 'dualEntry'

export interface StrategyPreset {
  id?: number
  strategy: StrategyType
  name: string
  config: Record<string, unknown>
  isDefault: boolean
  createdAt?: number
  updatedAt?: number
}

// Momentum-specific config
export interface MomentumConfig {
  positionSize: number
  warmupSeconds: number
  selectedAssets: string[]
  takeProfitEnabled?: boolean
  takeProfitThreshold?: number
  maxHedges?: number
}

// Dual-entry specific config
export interface DualEntryConfig {
  positionSize: number
  selectedAssets: string[]
  loserDropPct?: number
  winnerGainPct?: number
}

/**
 * Get all presets for a strategy
 */
export async function getPresetsByStrategy(strategy: StrategyType): Promise<StrategyPreset[]> {
  try {
    const res = await fetch(`${API_URL}/presets/strategy/${strategy}`)
    if (!res.ok) throw new Error('Failed to fetch presets')
    return await res.json()
  } catch (error) {
    console.error('[CONFIG] Error fetching presets:', error)
    return []
  }
}

/**
 * Get all presets (all strategies)
 */
export async function getAllPresets(): Promise<StrategyPreset[]> {
  try {
    const res = await fetch(`${API_URL}/presets`)
    if (!res.ok) throw new Error('Failed to fetch presets')
    return await res.json()
  } catch (error) {
    console.error('[CONFIG] Error fetching all presets:', error)
    return []
  }
}

/**
 * Get all defaults (one per strategy)
 */
export async function getAllDefaults(): Promise<StrategyPreset[]> {
  try {
    const res = await fetch(`${API_URL}/presets/defaults`)
    if (!res.ok) throw new Error('Failed to fetch defaults')
    return await res.json()
  } catch (error) {
    console.error('[CONFIG] Error fetching defaults:', error)
    return []
  }
}

/**
 * Get preset by strategy and name
 */
export async function getPreset(strategy: StrategyType, name: string): Promise<StrategyPreset | null> {
  try {
    const res = await fetch(`${API_URL}/presets/strategy/${strategy}/${encodeURIComponent(name)}`)
    if (!res.ok) {
      if (res.status === 404) return null
      throw new Error('Failed to fetch preset')
    }
    return await res.json()
  } catch (error) {
    console.error('[CONFIG] Error loading preset:', error)
    return null
  }
}

/**
 * Get the default preset for a strategy
 */
export async function getDefaultPreset(strategy: StrategyType): Promise<StrategyPreset | null> {
  try {
    const res = await fetch(`${API_URL}/presets/strategy/${strategy}/default`)
    if (!res.ok) {
      if (res.status === 404) return null
      throw new Error('Failed to fetch default preset')
    }
    return await res.json()
  } catch (error) {
    console.error('[CONFIG] Error loading default preset:', error)
    return null
  }
}

/**
 * Save or update a preset for a strategy
 */
export async function savePreset(
  strategy: StrategyType,
  name: string,
  config: MomentumConfig | DualEntryConfig,
  isDefault = false
): Promise<StrategyPreset | null> {
  try {
    const res = await fetch(`${API_URL}/presets/strategy/${strategy}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config, isDefault }),
    })
    if (!res.ok) throw new Error('Failed to save preset')
    return await res.json()
  } catch (error) {
    console.error('[CONFIG] Error saving preset:', error)
    return null
  }
}

/**
 * Set a preset as the default for a strategy
 */
export async function setDefaultPreset(strategy: StrategyType, name: string): Promise<StrategyPreset | null> {
  try {
    const res = await fetch(`${API_URL}/presets/strategy/${strategy}/${encodeURIComponent(name)}/default`, {
      method: 'PUT',
    })
    if (!res.ok) throw new Error('Failed to set default')
    return await res.json()
  } catch (error) {
    console.error('[CONFIG] Error setting default:', error)
    return null
  }
}

/**
 * Clear the default for a strategy
 */
export async function clearDefault(strategy: StrategyType): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/presets/strategy/${strategy}/default`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error('Failed to clear default')
  } catch (error) {
    console.error('[CONFIG] Error clearing default:', error)
  }
}

/**
 * Delete a preset
 */
export async function deletePreset(strategy: StrategyType, name: string): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/presets/strategy/${strategy}/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error('Failed to delete preset')
  } catch (error) {
    console.error('[CONFIG] Error deleting preset:', error)
  }
}
