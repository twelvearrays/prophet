import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { tradingApi, TradingStatus } from '@/lib/tradingApi'

const AVAILABLE_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'] as const
type Asset = typeof AVAILABLE_ASSETS[number]

interface LiveTradingPanelProps {
  onStatusChange?: (isLive: boolean) => void
  onPositionSizeChange?: (size: number) => void
  onAssetsChange?: (assets: Asset[]) => void
  onWarmupChange?: (seconds: number) => void
  positionSize?: number
  selectedAssets?: Asset[]
  warmupSeconds?: number
}

export function LiveTradingPanel({
  onStatusChange,
  onPositionSizeChange,
  onAssetsChange,
  onWarmupChange,
  positionSize = 1,
  selectedAssets = ['BTC'],
  warmupSeconds = 60,
}: LiveTradingPanelProps) {
  const [status, setStatus] = useState<TradingStatus | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [localPositionSize, setLocalPositionSize] = useState(positionSize)
  const [localAssets, setLocalAssets] = useState<Asset[]>(selectedAssets)
  const [localWarmup, setLocalWarmup] = useState(warmupSeconds)

  // Sync with external props
  useEffect(() => {
    setLocalPositionSize(positionSize)
  }, [positionSize])

  useEffect(() => {
    setLocalAssets(selectedAssets)
  }, [selectedAssets])

  useEffect(() => {
    setLocalWarmup(warmupSeconds)
  }, [warmupSeconds])

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

  const handlePositionSizeChange = (delta: number) => {
    const newSize = Math.max(1, Math.min(100, localPositionSize + delta))
    setLocalPositionSize(newSize)
    onPositionSizeChange?.(newSize)

    // Update backend if live
    if (status?.enabled) {
      tradingApi.updateConfig({ investmentPerSide: newSize }).catch(console.error)
    }
  }

  const handlePositionSizeInput = (value: string) => {
    const num = parseInt(value, 10)
    if (!isNaN(num) && num >= 1 && num <= 100) {
      setLocalPositionSize(num)
      onPositionSizeChange?.(num)

      // Update backend if live
      if (status?.enabled) {
        tradingApi.updateConfig({ investmentPerSide: num }).catch(console.error)
      }
    }
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

  const handleWarmupChange = (delta: number) => {
    const newWarmup = Math.max(0, Math.min(720, localWarmup + delta))
    setLocalWarmup(newWarmup)
    onWarmupChange?.(newWarmup)
  }

  const handleWarmupInput = (value: string) => {
    const num = parseInt(value, 10)
    if (!isNaN(num) && num >= 0 && num <= 720) {
      setLocalWarmup(num)
      onWarmupChange?.(num)
    }
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

        {/* Position Size Control */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">Position Size (per side)</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handlePositionSizeChange(-5)}
              className="px-2 py-1 text-sm font-medium rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              -5
            </button>
            <button
              onClick={() => handlePositionSizeChange(-1)}
              className="px-2 py-1 text-sm font-medium rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              -1
            </button>
            <div className="flex-1 flex items-center justify-center">
              <span className="text-lg font-mono text-zinc-100">$</span>
              <input
                type="number"
                value={localPositionSize}
                onChange={(e) => handlePositionSizeInput(e.target.value)}
                className="w-12 text-lg font-mono text-zinc-100 bg-transparent border-none text-center focus:outline-none focus:ring-1 focus:ring-zinc-600 rounded"
                min={1}
                max={100}
              />
            </div>
            <button
              onClick={() => handlePositionSizeChange(1)}
              className="px-2 py-1 text-sm font-medium rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              +1
            </button>
            <button
              onClick={() => handlePositionSizeChange(5)}
              className="px-2 py-1 text-sm font-medium rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              +5
            </button>
          </div>
          <div className="text-xs text-zinc-600 text-center">
            Total per trade: ${localPositionSize * 2} (${localPositionSize} YES + ${localPositionSize} NO)
          </div>
        </div>

        {/* Warmup Control (Momentum Strategy) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">Momentum Warmup</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleWarmupChange(-30)}
              className="px-2 py-1 text-sm font-medium rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              -30
            </button>
            <button
              onClick={() => handleWarmupChange(-10)}
              className="px-2 py-1 text-sm font-medium rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              -10
            </button>
            <div className="flex-1 flex items-center justify-center">
              <input
                type="number"
                value={localWarmup}
                onChange={(e) => handleWarmupInput(e.target.value)}
                className="w-14 text-lg font-mono text-zinc-100 bg-transparent border-none text-center focus:outline-none focus:ring-1 focus:ring-zinc-600 rounded"
                min={0}
                max={720}
              />
              <span className="text-sm font-mono text-zinc-400 ml-1">sec</span>
            </div>
            <button
              onClick={() => handleWarmupChange(10)}
              className="px-2 py-1 text-sm font-medium rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              +10
            </button>
            <button
              onClick={() => handleWarmupChange(30)}
              className="px-2 py-1 text-sm font-medium rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              +30
            </button>
          </div>
          <div className="text-xs text-zinc-600 text-center">
            Wait before first momentum trade (0 = no warmup)
          </div>
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
