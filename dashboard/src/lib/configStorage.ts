/**
 * Configuration Storage Service
 *
 * Saves/loads trading configurations via backend API (SQLite)
 * Supports named presets with isDefault flag
 */

const API_URL = 'http://localhost:3001/api'

export interface SavedConfig {
  id?: number
  name: string
  positionSize: number
  warmupSeconds: number
  selectedAssets: string[]
  isDefault: boolean
  createdAt?: number
  updatedAt?: number
}

/**
 * Get all saved configurations
 */
export async function getSavedConfigs(): Promise<SavedConfig[]> {
  try {
    const res = await fetch(`${API_URL}/presets`)
    if (!res.ok) throw new Error('Failed to fetch presets')
    return await res.json()
  } catch (error) {
    console.error('[CONFIG] Error fetching presets:', error)
    return []
  }
}

/**
 * Get preset by name
 */
export async function loadConfig(name: string): Promise<SavedConfig | null> {
  try {
    const res = await fetch(`${API_URL}/presets/${encodeURIComponent(name)}`)
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
 * Get the default preset
 */
export async function loadDefaultConfig(): Promise<SavedConfig | null> {
  try {
    const res = await fetch(`${API_URL}/presets/default`)
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
 * Save or update a preset
 */
export async function saveConfig(config: {
  name: string
  positionSize: number
  warmupSeconds: number
  selectedAssets: string[]
  isDefault?: boolean
}): Promise<SavedConfig | null> {
  try {
    const res = await fetch(`${API_URL}/presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    if (!res.ok) throw new Error('Failed to save preset')
    return await res.json()
  } catch (error) {
    console.error('[CONFIG] Error saving preset:', error)
    return null
  }
}

/**
 * Set a preset as the default
 */
export async function setDefaultConfig(name: string): Promise<SavedConfig | null> {
  try {
    const res = await fetch(`${API_URL}/presets/${encodeURIComponent(name)}/default`, {
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
 * Clear the default preset
 */
export async function clearDefaultConfig(): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/presets/default`, {
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
export async function deleteConfig(name: string): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/presets/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error('Failed to delete preset')
  } catch (error) {
    console.error('[CONFIG] Error deleting preset:', error)
  }
}
