/**
 * Multi-Outcome Arbitrage Scanner Client
 *
 * Based on Frank-Wolfe arbitrage principles from
 * "Arbitrage-Free Combinatorial Market Making via Integer Programming"
 *
 * Scans for NegRisk / multi-outcome events where:
 * - sum(outcome probabilities) should equal 1
 * - if sum < 1: BUY ALL outcomes for guaranteed profit
 * - if sum > 1: SELL ALL outcomes for guaranteed profit
 */

const API_URL = 'http://localhost:3001'

// ============================================================================
// TYPES
// ============================================================================

export interface Outcome {
  id: string
  question: string
  groupItemTitle: string
  price: number
  liquidity: number
}

export interface MultiOutcomeEvent {
  id: string
  slug: string
  title: string
  description?: string
  url: string                 // Link to Polymarket event page
  isNegRisk: boolean
  numOutcomes: number
  outcomes: Outcome[]
  totalYesPrice: number      // Sum of all outcome prices
  mispricing: number         // totalYesPrice - 1 (+ means overbought, - means underbought)
  absoluteMispricing: number
  opportunityType: 'BUY_ALL' | 'SELL_ALL' | 'NONE'
  rawProfit: number
  fees: number
  profitAfterFees: number
  minLiquidity: number
  qualifies: boolean
  reasons: string[]
  lastUpdated: number
}

export interface ScanResult {
  events: MultiOutcomeEvent[]
  opportunities: MultiOutcomeEvent[]
  totalEvents: number
  multiOutcomeEvents: number
  withMispricing: number
  qualifyingOpportunities: number
  scanTime: number
  timestamp: number
  errors: string[]
  scanType: 'multi-outcome'
}

export interface ScannerConfig {
  minLiquidity: number
  minMispricing: number
  maxEvents: number
  feeRate: number
  alphaExtraction: number
}

// ============================================================================
// TYPE 2: CROSS-MARKET DEPENDENCY TYPES
// ============================================================================

export interface MarketRef {
  id: string
  question: string
  price: number
}

export interface CrossMarketDependency {
  type: 'temporal' | 'threshold'
  marketA: MarketRef
  marketB: MarketRef
  expectedRelation: string // 'A <= B' or 'A >= B'
  reasoning: string
  violation: boolean
  arbitrageProfit: number
  profitAfterFees: number
  qualifies: boolean
  reasons: string[]
}

export interface CrossMarketScanResult {
  dependencies: CrossMarketDependency[]
  opportunities: CrossMarketDependency[]
  stats: {
    totalMarkets: number
    temporalDependencies: number
    thresholdDependencies: number
    violations: number
    qualifyingOpportunities: number
    scanTime?: number
  }
  timestamp: number
  errors?: string[]
}

// ============================================================================
// TYPE 3: SETTLEMENT LAG TYPES
// ============================================================================

export interface SettlementLagSignal {
  type: 'PRICE_VOLUME_DIVERGENCE' | 'BOUNDARY_RUSH' | 'STALE_PRICE' | 'PAST_RESOLUTION' | 'EXTREME_SPREAD'
  detected: boolean
  details: Record<string, string | number | null>
}

export interface SettlementLagStrategy {
  action: 'BUY' | 'SELL' | 'WAIT'
  side: 'YES' | 'NO' | null
  explanation: string
}

export interface SettlementLagOpportunity {
  marketId: string
  question: string
  currentPrice: number
  expectedPrice: number
  potentialProfit: number
  hasOpportunity: boolean
  confidence: number
  signals: SettlementLagSignal[]
  strategy: SettlementLagStrategy
  type: 'SETTLEMENT_LAG'
}

export interface SettlementLagScanResult {
  opportunities: SettlementLagOpportunity[]
  stats: {
    totalMarkets: number
    marketsAnalyzed: number
    opportunitiesFound: number
    totalPotentialProfit: number
  }
  scanTime: number
  timestamp: number
  errors?: string[]
}

// ============================================================================
// FRANK-WOLFE METRICS (enhanced Type 1)
// ============================================================================

export interface FrankWolfeMetrics {
  bregmanDivergence: number
  guaranteedProfit: number
  extractionRate: number
  maxPositionSize: number
  expectedDollarProfit: number
}

// ============================================================================
// SCANNER CLIENT
// ============================================================================

export class ArbitrageScanner {
  private listeners: Set<(result: ScanResult) => void> = new Set()
  private lastResult: ScanResult | null = null
  private connected = false
  private connectionListeners: Set<(connected: boolean) => void> = new Set()

  constructor() {
    this.checkConnection()
  }

  private async checkConnection() {
    try {
      const response = await fetch(`${API_URL}/api/health`)
      if (response.ok) {
        console.log('[ARB-SCANNER] Backend connected')
        this.connected = true
        this.connectionListeners.forEach(cb => cb(true))
      } else {
        throw new Error('Health check failed')
      }
    } catch (e) {
      console.log('[ARB-SCANNER] Backend not available, retrying...')
      this.connected = false
      this.connectionListeners.forEach(cb => cb(false))
      setTimeout(() => this.checkConnection(), 5000)
    }
  }

  async scan(): Promise<ScanResult> {
    try {
      const response = await fetch(`${API_URL}/api/arbitrage/scan`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const result = await response.json()

      // Validate result has required fields
      if (!result || typeof result !== 'object') {
        throw new Error('Invalid response from server')
      }

      // Ensure arrays exist
      const validResult: ScanResult = {
        events: result.events || [],
        opportunities: result.opportunities || [],
        totalEvents: result.totalEvents || 0,
        multiOutcomeEvents: result.multiOutcomeEvents || 0,
        withMispricing: result.withMispricing || 0,
        qualifyingOpportunities: result.qualifyingOpportunities || 0,
        scanTime: result.scanTime || 0,
        timestamp: result.timestamp || Date.now(),
        errors: result.errors || [],
        scanType: 'multi-outcome',
      }

      this.lastResult = validResult
      this.connected = true
      this.connectionListeners.forEach(cb => cb(true))
      this.listeners.forEach(cb => cb(validResult))
      return validResult
    } catch (e: unknown) {
      const error = e as Error
      console.error('[ARB-SCANNER] Scan failed:', error)
      this.connected = false
      this.connectionListeners.forEach(cb => cb(false))
      const emptyResult = this.createEmptyResult(`Scan failed: ${error.message}`)
      this.listeners.forEach(cb => cb(emptyResult))
      return emptyResult
    }
  }

  async getLastResult(): Promise<ScanResult> {
    if (this.lastResult) {
      return this.lastResult
    }

    try {
      const response = await fetch(`${API_URL}/api/arbitrage/result`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const result = await response.json()
      this.lastResult = result
      return result
    } catch (e: unknown) {
      const error = e as Error
      return this.createEmptyResult(`Failed to get results: ${error.message}`)
    }
  }

  private createEmptyResult(error: string): ScanResult {
    return {
      events: [],
      opportunities: [],
      totalEvents: 0,
      multiOutcomeEvents: 0,
      withMispricing: 0,
      qualifyingOpportunities: 0,
      scanTime: 0,
      timestamp: Date.now(),
      errors: [error],
      scanType: 'multi-outcome',
    }
  }

  subscribe(callback: (result: ScanResult) => void): () => void {
    this.listeners.add(callback)
    if (this.lastResult) {
      callback(this.lastResult)
    }
    return () => this.listeners.delete(callback)
  }

  onConnectionChange(callback: (connected: boolean) => void): () => void {
    this.connectionListeners.add(callback)
    callback(this.connected)
    return () => this.connectionListeners.delete(callback)
  }

  startContinuousScan(intervalMs: number = 10000): () => void {
    let running = true

    const loop = async () => {
      while (running) {
        await this.scan()
        await new Promise(r => setTimeout(r, intervalMs))
      }
    }

    this.scan()
    loop()

    return () => { running = false }
  }

  async updateConfig(config: Partial<ScannerConfig>) {
    try {
      await fetch(`${API_URL}/api/arbitrage/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
    } catch (e) {
      console.error('[ARB-SCANNER] Failed to update config:', e)
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  getConfig(): ScannerConfig {
    return {
      minLiquidity: 100,
      minMispricing: 0.02,
      maxEvents: 100,
      feeRate: 0.02,
      alphaExtraction: 0.9,
    }
  }

  // ============================================================================
  // TYPE 2: CROSS-MARKET DEPENDENCY SCANNING
  // ============================================================================

  private lastCrossMarketResult: CrossMarketScanResult | null = null
  private crossMarketListeners: Set<(result: CrossMarketScanResult) => void> = new Set()

  async scanCrossMarket(): Promise<CrossMarketScanResult> {
    try {
      const response = await fetch(`${API_URL}/api/arbitrage/cross-market`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const result = await response.json()
      this.lastCrossMarketResult = result
      this.crossMarketListeners.forEach(cb => cb(result))
      return result
    } catch (e: unknown) {
      const error = e as Error
      console.error('[ARB-SCANNER] Cross-market scan failed:', error)
      return this.createEmptyCrossMarketResult(`Scan failed: ${error.message}`)
    }
  }

  async getLastCrossMarketResult(): Promise<CrossMarketScanResult> {
    if (this.lastCrossMarketResult) {
      return this.lastCrossMarketResult
    }

    try {
      const response = await fetch(`${API_URL}/api/arbitrage/cross-market/result`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const result = await response.json()
      this.lastCrossMarketResult = result
      return result
    } catch (e: unknown) {
      const error = e as Error
      return this.createEmptyCrossMarketResult(`Failed to get results: ${error.message}`)
    }
  }

  private createEmptyCrossMarketResult(error: string): CrossMarketScanResult {
    return {
      dependencies: [],
      opportunities: [],
      stats: {
        totalMarkets: 0,
        temporalDependencies: 0,
        thresholdDependencies: 0,
        violations: 0,
        qualifyingOpportunities: 0,
      },
      timestamp: Date.now(),
      errors: [error],
    }
  }

  subscribeCrossMarket(callback: (result: CrossMarketScanResult) => void): () => void {
    this.crossMarketListeners.add(callback)
    if (this.lastCrossMarketResult) {
      callback(this.lastCrossMarketResult)
    }
    return () => this.crossMarketListeners.delete(callback)
  }

  // ============================================================================
  // TYPE 3: SETTLEMENT LAG SCANNING
  // ============================================================================

  private lastSettlementLagResult: SettlementLagScanResult | null = null
  private settlementLagListeners: Set<(result: SettlementLagScanResult) => void> = new Set()

  async scanSettlementLag(): Promise<SettlementLagScanResult> {
    try {
      const response = await fetch(`${API_URL}/api/arbitrage/settlement-lag`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const result = await response.json()
      this.lastSettlementLagResult = result
      this.settlementLagListeners.forEach(cb => cb(result))
      return result
    } catch (e: unknown) {
      const error = e as Error
      console.error('[ARB-SCANNER] Settlement lag scan failed:', error)
      return this.createEmptySettlementLagResult(`Scan failed: ${error.message}`)
    }
  }

  async getLastSettlementLagResult(): Promise<SettlementLagScanResult> {
    if (this.lastSettlementLagResult) {
      return this.lastSettlementLagResult
    }

    try {
      const response = await fetch(`${API_URL}/api/arbitrage/settlement-lag/result`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const result = await response.json()
      this.lastSettlementLagResult = result
      return result
    } catch (e: unknown) {
      const error = e as Error
      return this.createEmptySettlementLagResult(`Failed to get results: ${error.message}`)
    }
  }

  private createEmptySettlementLagResult(error: string): SettlementLagScanResult {
    return {
      opportunities: [],
      stats: {
        totalMarkets: 0,
        marketsAnalyzed: 0,
        opportunitiesFound: 0,
        totalPotentialProfit: 0,
      },
      scanTime: 0,
      timestamp: Date.now(),
      errors: [error],
    }
  }

  subscribeSettlementLag(callback: (result: SettlementLagScanResult) => void): () => void {
    this.settlementLagListeners.add(callback)
    if (this.lastSettlementLagResult) {
      callback(this.lastSettlementLagResult)
    }
    return () => this.settlementLagListeners.delete(callback)
  }
}

// Singleton instance
export const arbitrageScanner = new ArbitrageScanner()
