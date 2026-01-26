import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { tradingApi, TradingStatus } from '@/lib/tradingApi'

const AVAILABLE_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'] as const
type Asset = typeof AVAILABLE_ASSETS[number]

interface LiveTradingPanelProps {
  onStatusChange?: (isLive: boolean) => void
  onAssetsChange?: (assets: Asset[]) => void
  positionSize?: number
  selectedAssets?: Asset[]
}

export function LiveTradingPanel({
  onStatusChange,
  onAssetsChange,
  positionSize = 1,
  selectedAssets = ['BTC'],
}: LiveTradingPanelProps) {
  const [status, setStatus] = useState<TradingStatus | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [localPositionSize, setLocalPositionSize] = useState(positionSize)
  const [localAssets, setLocalAssets] = useState<Asset[]>(selectedAssets)

  // Sync with external props
  useEffect(() => {
    setLocalPositionSize(positionSize)
  }, [positionSize])

  useEffect(() => {
    setLocalAssets(selectedAssets)
  }, [selectedAssets])

  // Check status on mount
  useEffect(() => {
    checkStatus()
  }, [])

  const checkStatus = async () => {
    try {
      const s = await tradingApi.getStatus()
      setStatus(s)
      if (s.enabled) {
        const bal = await tradingApi.getBalance()
        setBalance(bal)
      }
      onStatusChange?.(s.enabled)
    } catch (e) {
      // Backend might not be running or trading not initialized
      setStatus(null)
    }
  }

  const enableLiveTrading = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await tradingApi.initialize()
      setBalance(result.balance)

      // Update position size in backend
      await tradingApi.updateConfig({ investmentPerSide: localPositionSize })

      await checkStatus()
      onStatusChange?.(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to enable live trading')
    } finally {
      setIsLoading(false)
    }
  }

  const disableLiveTrading = () => {
    tradingApi.disable()
    setStatus(prev => prev ? { ...prev, enabled: false } : null)
    onStatusChange?.(false)
  }

  const toggleAsset = (asset: Asset) => {
    const newAssets = localAssets.includes(asset)
      ? localAssets.filter(a => a !== asset)
      : [...localAssets, asset]

    // Ensure at least one asset is selected
    if (newAssets.length === 0) return

    setLocalAssets(newAssets)
    onAssetsChange?.(newAssets)
  }

  const isLive = status?.enabled ?? false

  return (
    <Card className={`border ${isLive ? 'border-red-500/50 bg-red-500/5' : 'border-zinc-700'}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            {isLive ? (
              <>
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-red-400">LIVE TRADING</span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-zinc-500" />
                <span className="text-zinc-400">Paper Trading</span>
              </>
            )}
          </CardTitle>
          {isLive && balance !== null && (
            <span className="text-xs font-mono text-zinc-400">
              ${balance.toFixed(2)} USDC
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
            {error}
          </div>
        )}

        {/* Asset Selection */}
        <div className="space-y-2">
          <span className="text-xs text-zinc-500">Assets to Trade</span>
          <div className="flex flex-wrap gap-1.5">
            {AVAILABLE_ASSETS.map(asset => (
              <button
                key={asset}
                onClick={() => toggleAsset(asset)}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                  localAssets.includes(asset)
                    ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                    : 'bg-zinc-800 text-zinc-500 border border-zinc-700 hover:text-zinc-400'
                }`}
              >
                {asset}
              </button>
            ))}
          </div>
        </div>

        {/* Position Size Display */}
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-500">Position Size</span>
          <span className="font-mono text-zinc-300">${localPositionSize}/side</span>
        </div>

        {isLive ? (
          <div className="space-y-3 pt-2 border-t border-zinc-800">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-500">Wallet</span>
              <span className="font-mono text-zinc-300">
                {status?.address?.slice(0, 6)}...{status?.address?.slice(-4)}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-500">Daily P&L</span>
              <span className={`font-mono ${(status?.dailyPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {(status?.dailyPnl ?? 0) >= 0 ? '+' : ''}${(status?.dailyPnl ?? 0).toFixed(2)}
              </span>
            </div>

            <div className="pt-2">
              <button
                onClick={disableLiveTrading}
                className="w-full px-3 py-2 text-sm font-medium rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                Switch to Paper Trading
              </button>
            </div>

            <p className="text-xs text-red-400/70 text-center">
              ⚠️ Real money is at risk
            </p>
          </div>
        ) : (
          <div className="space-y-3 pt-2 border-t border-zinc-800">
            <p className="text-xs text-zinc-500">
              Enable live trading to execute real orders on Polymarket.
            </p>

            <button
              onClick={enableLiveTrading}
              disabled={isLoading}
              className="w-full px-3 py-2 text-sm font-medium rounded-md bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors disabled:opacity-50"
            >
              {isLoading ? 'Connecting...' : '🔴 Enable Live Trading'}
            </button>

            <p className="text-xs text-zinc-500 text-center">
              Requires backend with valid .env credentials
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
