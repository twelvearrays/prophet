// Trading API Client - Connects frontend to backend live trading
// This bridges the paper trading logic with real order execution

const API_URL = 'http://localhost:3001/api'

export interface TradingStatus {
  enabled: boolean
  address: string | null
  dailyPnl: number
  activePositions: number
  config: {
    investmentPerSide: number
    maxPositionSize: number
    maxDailyLoss: number
    makerBidPrice: number
    makerAskPrice: number
  }
}

export interface OrderResult {
  orderId: string
  tokenId: string
  side: string
  price: number
  size: number
  status: string
  isTaker?: boolean
  isMaker?: boolean
  timestamp: number
}

export interface MarketOrderResult {
  orderID: string
  takingAmount: string
  makingAmount: string
  status: string
  success: boolean
  transactionsHashes?: string[]
}

class TradingApi {
  private _isLive = false

  get isLive() {
    return this._isLive
  }

  // Initialize trading client (call once when enabling live trading)
  async initialize(): Promise<{ success: boolean; address: string; balance: number }> {
    const res = await fetch(`${API_URL}/trading/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}), // Credentials come from backend .env
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Failed to initialize trading')
    }

    const result = await res.json()
    this._isLive = true
    console.log('[TRADING API] Initialized:', result.address, `Balance: $${result.balance}`)
    return result
  }

  // Check trading status
  async getStatus(): Promise<TradingStatus> {
    const res = await fetch(`${API_URL}/trading/status`)
    if (!res.ok) throw new Error('Failed to get trading status')
    const status = await res.json()
    this._isLive = status.enabled
    return status
  }

  // Get USDC balance
  async getBalance(): Promise<number> {
    const res = await fetch(`${API_URL}/trading/balance`)
    if (!res.ok) throw new Error('Failed to get balance')
    const data = await res.json()
    return data.balance
  }

  // Get token balance (shares owned)
  async getTokenBalance(tokenId: string): Promise<number> {
    const res = await fetch(`${API_URL}/trading/balance/${tokenId}`)
    if (!res.ok) throw new Error('Failed to get token balance')
    const data = await res.json()
    return data.balance
  }

  // Get open orders
  async getOpenOrders(): Promise<unknown[]> {
    const res = await fetch(`${API_URL}/trading/orders`)
    if (!res.ok) throw new Error('Failed to get orders')
    const data = await res.json()
    return data.orders
  }

  // Place a limit order (maker order)
  async placeLimitOrder(params: {
    tokenId: string
    side: 'BUY' | 'SELL'
    price: number
    size: number
  }): Promise<OrderResult> {
    console.log(`[TRADING API] Placing limit order:`, params)

    const res = await fetch(`${API_URL}/trading/order/limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Failed to place limit order')
    }

    const result = await res.json()
    console.log(`[TRADING API] Limit order placed:`, result.orderId)
    return result
  }

  // Place a market order (taker order)
  async placeMarketOrder(params: {
    tokenId: string
    side: 'BUY' | 'SELL'
    amount: number
  }): Promise<MarketOrderResult> {
    console.log(`[TRADING API] Placing market order:`, params)

    const res = await fetch(`${API_URL}/trading/order/market`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Failed to place market order')
    }

    const result = await res.json()
    console.log(`[TRADING API] Market order result:`, result.status)
    return result
  }

  // Place dual-entry maker orders (4 limit orders)
  async placeDualEntryOrders(params: {
    yesTokenId: string
    noTokenId: string
    marketId: string
  }): Promise<{ success: boolean; orders: OrderResult[] }> {
    console.log(`[TRADING API] Placing dual-entry orders for market:`, params.marketId)

    const res = await fetch(`${API_URL}/trading/order/dual-entry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Failed to place dual-entry orders')
    }

    const result = await res.json()
    console.log(`[TRADING API] Dual-entry orders placed:`, result.orders?.length)
    return result
  }

  // Cancel an order
  async cancelOrder(orderId: string): Promise<void> {
    console.log(`[TRADING API] Cancelling order:`, orderId)

    const res = await fetch(`${API_URL}/trading/order/${orderId}`, {
      method: 'DELETE',
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Failed to cancel order')
    }

    console.log(`[TRADING API] Order cancelled`)
  }

  // Cancel all orders
  async cancelAllOrders(): Promise<string[]> {
    console.log(`[TRADING API] Cancelling all orders`)

    const res = await fetch(`${API_URL}/trading/orders`, {
      method: 'DELETE',
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Failed to cancel orders')
    }

    const result = await res.json()
    console.log(`[TRADING API] Cancelled ${result.cancelled?.length || 0} orders`)
    return result.cancelled || []
  }

  // Get active positions
  async getPositions(): Promise<unknown[]> {
    const res = await fetch(`${API_URL}/trading/positions`)
    if (!res.ok) throw new Error('Failed to get positions')
    const data = await res.json()
    return data.positions
  }

  // Update trading config (position size, etc.)
  async updateConfig(config: Partial<{
    investmentPerSide: number
    maxPositionSize: number
    maxDailyLoss: number
    makerBidPrice: number
    makerAskPrice: number
  }>): Promise<void> {
    console.log(`[TRADING API] Updating config:`, config)

    const res = await fetch(`${API_URL}/trading/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Failed to update config')
    }

    console.log(`[TRADING API] Config updated`)
  }

  // Disable live trading (just sets the flag - doesn't cancel orders)
  disable() {
    this._isLive = false
    console.log('[TRADING API] Live trading disabled')
  }
}

// Singleton instance
export const tradingApi = new TradingApi()
