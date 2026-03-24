import { useParams, useNavigate } from 'react-router-dom'
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import { useState, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { usePool } from '../hooks/usePool'
import GlassCard from '../components/ui/GlassCard'
import StatusBadge from '../components/ui/StatusBadge'
import TickRangeBar from '../components/ui/TickRangeBar'
import { VAULT_ABI, ROUTER_ABI, ERC20_ABI, POOL_ABI } from '../lib/abis'
import { formatAddress, formatTimestamp } from '../lib/formatUtils'
import { tickToPrice, formatPrice, getPriceLabel } from '../lib/priceUtils'
import {
  ArrowLeft, Zap, Shield, Eye, EyeOff, RefreshCw,
  ExternalLink, Loader2, Activity, Fuel, DollarSign, Layers,
  AlertTriangle
} from 'lucide-react'

const ROUTER_ADDRESS = (import.meta.env.VITE_ROUTER_ADDRESS ?? '') as `0x${string}`
const EXPLORER_URL = 'https://shannon-explorer.somnia.network'

export default function VaultDetailPage() {
  const { poolAddress } = useParams<{ poolAddress: string }>()
  const navigate = useNavigate()
  const { address: userAddress } = useAccount()
  const queryClient = useQueryClient()

  const { pool, isLoading, lastRebalance, refreshFromChain } = usePool(poolAddress)

  const vaultAddress = pool?.vaultAddress as `0x${string}` | undefined
  const poolAddr = pool?.poolAddress as `0x${string}` | undefined

  // On-chain reads
  const { data: vaultOwner } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: 'owner',
    query: { enabled: !!vaultAddress, refetchInterval: 10000 },
  })

  const { data: currentTokenId } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: 'tokenId',
    query: { enabled: !!vaultAddress, refetchInterval: 5000 },
  })

  const { data: subscriptionId } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: 'subscriptionId',
    query: { enabled: !!vaultAddress, refetchInterval: 5000 },
  })

  const { data: backupSubId } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: 'backupSubscriptionId',
    query: { enabled: !!vaultAddress, refetchInterval: 5000 },
  })

  const { data: sttBalanceRaw } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: 'sttBalance',
    query: { enabled: !!vaultAddress, refetchInterval: 15000 },
  })

  const { data: slot0Data } = useReadContract({
    address: poolAddr,
    abi: POOL_ABI,
    functionName: 'slot0',
    query: { enabled: !!poolAddr, refetchInterval: 5000 },
  })

  const isOwner = userAddress && vaultOwner && userAddress.toLowerCase() === (vaultOwner as string).toLowerCase()
  const sttBalance = sttBalanceRaw ? parseFloat(formatUnits(sttBalanceRaw as bigint, 18)) : 0
  const liveCurrentTick = slot0Data ? Number((slot0Data as any)[1]) : pool?.liveData?.currentTick

  // Compute prices from ticks
  const priceInfo = useMemo(() => {
    const t0 = pool?.token0
    const t1 = pool?.token1
    if (!t0 || !t1) return { current: '—', lower: '—', upper: '—', label: '—' }

    const currentPrice = liveCurrentTick != null
      ? tickToPrice(liveCurrentTick, t0.decimals, t1.decimals)
      : pool?.liveData?.price

    const lowerPrice = pool?.liveData?.tickLower != null
      ? tickToPrice(pool.liveData.tickLower, t0.decimals, t1.decimals)
      : undefined

    const upperPrice = pool?.liveData?.tickUpper != null
      ? tickToPrice(pool.liveData.tickUpper, t0.decimals, t1.decimals)
      : undefined

    return {
      current: formatPrice(currentPrice),
      lower: formatPrice(lowerPrice),
      upper: formatPrice(upperPrice),
      label: pool?.liveData?.priceLabel ?? getPriceLabel(currentPrice, t0, t1),
    }
  }, [liveCurrentTick, pool])

  // Convert rebalance tick to price
  const rebalancePriceLabel = (tick: number) => {
    if (!pool?.token0 || !pool?.token1) return `Tick ${tick}`
    const price = tickToPrice(tick, pool.token0.decimals, pool.token1.decimals)
    return `${formatPrice(price)} ${pool.token0.symbol}/${pool.token1.symbol}`
  }

  // ── Health checks ──
  const sttLow = sttBalance < 32
  const poolBal0 = pool?.liveData?.poolBalance0 ? parseFloat(pool.liveData.poolBalance0) : null
  const poolBal1 = pool?.liveData?.poolBalance1 ? parseFloat(pool.liveData.poolBalance1) : null
  const pool0Empty = poolBal0 !== null && poolBal0 < 0.0001
  const pool1Empty = poolBal1 !== null && poolBal1 < 0.0001

  // Check if current tick is in range
  const inRange = useMemo(() => {
    if (liveCurrentTick == null || pool?.liveData?.tickLower == null || pool?.liveData?.tickUpper == null) return null
    return liveCurrentTick >= pool.liveData.tickLower && liveCurrentTick < pool.liveData.tickUpper
  }, [liveCurrentTick, pool?.liveData?.tickLower, pool?.liveData?.tickUpper])

  // ── Whale swap state ──
  const [swapAmount, setSwapAmount] = useState('0.5')
  const [swapDirection, setSwapDirection] = useState<'0to1' | '1to0'>('0to1')

  // Pre-swap: check output token liquidity
  const swapOutputEmpty = swapDirection === '0to1' ? pool1Empty : pool0Empty
  const swapOutputToken = swapDirection === '0to1' ? pool?.token1?.symbol : pool?.token0?.symbol

  // Approve for swap
  const { writeContract: approveSwap, data: approveSwapHash, reset: resetApprove } = useWriteContract()
  const { isLoading: isApproveSwapLoading, isSuccess: isApproveSwapSuccess } = useWaitForTransactionReceipt({ hash: approveSwapHash })

  // Execute swap
  const { writeContract: executeSwap, data: swapHash, reset: resetSwap } = useWriteContract()
  const { isLoading: isSwapLoading, isSuccess: isSwapSuccess } = useWaitForTransactionReceipt({ hash: swapHash })

  // Read user balance for the input token
  const inputTokenAddr = (swapDirection === '0to1' ? pool?.token0?.address : pool?.token1?.address) as `0x${string}` | undefined
  const inputTokenDecimals = swapDirection === '0to1' ? pool?.token0?.decimals : pool?.token1?.decimals

  const { data: userInputBalance } = useReadContract({
    address: inputTokenAddr,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: userAddress ? [userAddress] : undefined,
    query: { enabled: !!inputTokenAddr && !!userAddress, refetchInterval: 10000 },
  })

  const userBalance = userInputBalance != null && inputTokenDecimals != null
    ? parseFloat(formatUnits(userInputBalance as bigint, inputTokenDecimals))
    : null

  const insufficientBalance = userBalance !== null && parseFloat(swapAmount || '0') > userBalance

  // Reset approval state when direction changes
  useEffect(() => {
    resetApprove()
    resetSwap()
  }, [swapDirection])

  // Auto-refresh after swap confirms — show new tick position immediately
  useEffect(() => {
    if (isSwapSuccess) {
      queryClient.invalidateQueries()
      refreshFromChain()
      // Poll rapidly for 30s to catch reactivity rebalance
      const interval = setInterval(refreshFromChain, 2000)
      const timeout = setTimeout(() => clearInterval(interval), 30000)
      return () => { clearInterval(interval); clearTimeout(timeout) }
    }
  }, [isSwapSuccess, queryClient, refreshFromChain])

  // ── Admin actions ──
  const { writeContract: startWatch, data: startWatchHash } = useWriteContract()
  const { isLoading: isStartWatchLoading, isSuccess: isStartWatchSuccess } = useWaitForTransactionReceipt({ hash: startWatchHash })

  const { writeContract: stopWatch, data: stopWatchHash } = useWriteContract()
  const { isLoading: isStopWatchLoading, isSuccess: isStopWatchSuccess } = useWaitForTransactionReceipt({ hash: stopWatchHash })

  // Invalidate all queries when admin txs confirm — triggers immediate re-read of subscriptionId, config, etc.
  useEffect(() => {
    if (isStartWatchSuccess || isStopWatchSuccess) {
      queryClient.invalidateQueries()
      refreshFromChain()
    }
  }, [isStartWatchSuccess, isStopWatchSuccess, queryClient, refreshFromChain])

  // Rebalance flash effect
  const [showFlash, setShowFlash] = useState(false)
  useEffect(() => {
    if (lastRebalance) {
      setShowFlash(true)
      const priceStr = rebalancePriceLabel(lastRebalance.newTick)
      toast.success(`⚡ Rebalanced! New price: ${priceStr}`)
      const timer = setTimeout(() => setShowFlash(false), 2000)
      return () => clearTimeout(timer)
    }
  }, [lastRebalance])

  const handleApproveAndSwap = () => {
    if (!pool?.token0 || !pool?.token1) return
    const tokenIn = swapDirection === '0to1' ? pool.token0.address : pool.token1.address
    const decimals = swapDirection === '0to1' ? pool.token0.decimals : pool.token1.decimals
    const amountParsed = parseUnits(swapAmount, decimals)

    approveSwap({
      address: tokenIn as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [ROUTER_ADDRESS, amountParsed],
    }, {
      onSuccess: () => toast.success('Approval submitted'),
      onError: (err) => toast.error(`Approval failed: ${err.message.slice(0, 80)}`),
    })
  }

  const handleExecuteSwap = () => {
    if (!pool?.token0 || !pool?.token1 || !userAddress) return
    const tokenIn = swapDirection === '0to1' ? pool.token0.address : pool.token1.address
    const tokenOut = swapDirection === '0to1' ? pool.token1.address : pool.token0.address
    const decimals = swapDirection === '0to1' ? pool.token0.decimals : pool.token1.decimals

    executeSwap({
      address: ROUTER_ADDRESS,
      abi: ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: tokenIn as `0x${string}`,
        tokenOut: tokenOut as `0x${string}`,
        fee: pool.fee,
        recipient: userAddress,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
        amountIn: parseUnits(swapAmount, decimals),
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      }],
    }, {
      onSuccess: () => toast.success('🐋 Whale swap submitted! Watch for reactivity...'),
      onError: (err) => toast.error(`Swap failed: ${err.message.slice(0, 80)}`),
    })
  }

  const handleStartWatching = () => {
    if (!vaultAddress) return
    startWatch({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'startWatching',
      args: [3000000n],
    }, {
      onSuccess: () => toast.success('🛡️ Reactivity subscription started'),
      onError: (err) => toast.error(`Failed: ${err.message.slice(0, 80)}`),
    })
  }

  const handleStopWatching = () => {
    if (!vaultAddress) return
    stopWatch({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'stopWatching',
    }, {
      onSuccess: () => toast.success('Reactivity subscription stopped'),
      onError: (err) => toast.error(`Failed: ${err.message.slice(0, 80)}`),
    })
  }

  if (isLoading) {
    return (
      <div className="text-center py-20">
        <Zap className="w-12 h-12 mx-auto mb-3 animate-pulse text-[var(--color-neon-blue)]" />
        <p className="text-[var(--color-text-secondary)]">Loading vault data...</p>
      </div>
    )
  }

  const watching = pool?.liveData?.watching ?? false
  const initialized = pool?.liveData?.initialized ?? false
  const status = watching ? 'watching' : initialized ? 'unprotected' : 'initializing'

  return (
    <div className={`space-y-6 ${showFlash ? 'rebalance-flash' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/')} className="p-2 rounded-lg hover:bg-white/5 transition-colors cursor-pointer">
            <ArrowLeft className="w-5 h-5 text-[var(--color-text-secondary)]" />
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
                {pool?.token0?.symbol ?? '???'} / {pool?.token1?.symbol ?? '???'}
              </h1>
              <StatusBadge status={status} size="md" />
            </div>
            <p className="text-sm text-[var(--color-text-tertiary)] font-mono mt-0.5">
              Pool: {formatAddress(pool?.poolAddress)} • Vault: {formatAddress(pool?.vaultAddress)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refreshFromChain} className="p-2 rounded-lg hover:bg-white/5 transition-colors cursor-pointer" title="Refresh on-chain">
            <RefreshCw className="w-4 h-4 text-[var(--color-text-secondary)]" />
          </button>
          {pool?.poolAddress && (
            <a href={`${EXPLORER_URL}/address/${pool.poolAddress}`} target="_blank" rel="noreferrer" className="p-2 rounded-lg hover:bg-white/5 transition-colors">
              <ExternalLink className="w-4 h-4 text-[var(--color-text-secondary)]" />
            </a>
          )}
        </div>
      </div>

      {/* ── Health Warnings ──────────────────────────────────────── */}
      {(sttLow || inRange === false) && (
        <div className="space-y-2">
          {sttLow && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--color-status-danger)]/10 border border-[var(--color-status-danger)]/20 text-sm">
              <AlertTriangle className="w-5 h-5 text-[var(--color-status-danger)] shrink-0" />
              <div>
                <p className="font-semibold text-[var(--color-status-danger)]">Low STT Balance — Reactivity at Risk</p>
                <p className="text-[var(--color-text-secondary)] mt-0.5">
                  Vault has {sttBalance.toFixed(2)} STT (minimum 32 STT needed). Send STT to the vault address to keep reactivity active.
                </p>
              </div>
            </div>
          )}
          {inRange === false && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--color-neon-amber)]/10 border border-[var(--color-neon-amber)]/20 text-sm">
              <AlertTriangle className="w-5 h-5 text-[var(--color-neon-amber)] shrink-0" />
              <div>
                <p className="font-semibold text-[var(--color-neon-amber)]">Position Out of Range</p>
                <p className="text-[var(--color-text-secondary)] mt-0.5">
                  Current tick ({liveCurrentTick?.toLocaleString()}) is outside bounds [{pool?.liveData?.tickLower?.toLocaleString()}, {pool?.liveData?.tickUpper?.toLocaleString()}].
                  {watching ? ' Reactivity is active — rebalance should trigger on next swap.' : ' Reactivity is NOT active — start watching to enable auto-rebalance.'}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Live Telemetry ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Current Price', value: priceInfo.label, icon: DollarSign, color: 'var(--color-neon-blue)' },
          { label: 'LP Token ID', value: currentTokenId?.toString() ?? '—', icon: Activity, color: 'var(--color-neon-purple)' },
          { label: 'STT Balance', value: `${sttBalance.toFixed(2)} STT`, icon: Fuel, color: sttBalance < 32 ? 'var(--color-status-danger)' : 'var(--color-neon-green)' },
          { label: 'Sub ID', value: subscriptionId ? subscriptionId.toString() : '—', icon: Layers, color: 'var(--color-neon-amber)' },
        ].map(({ label, value, icon: Icon, color }) => (
          <GlassCard key={label} className="text-center py-4">
            <Icon className="w-5 h-5 mx-auto mb-2" style={{ color }} />
            <p className="text-xs text-[var(--color-text-tertiary)]">{label}</p>
            <p className="text-lg font-bold font-mono mt-1 truncate px-1" style={{ color }}>{value}</p>
          </GlassCard>
        ))}
      </div>

      {/* ── Price Range Visualization ────────────────────────────────── */}
      <GlassCard glow={watching ? 'green' : 'none'} className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5 text-[var(--color-neon-blue)]" />
            Price Range Monitor
          </h2>
          {priceInfo.label && priceInfo.label !== '—' && (
            <span className="text-sm font-mono text-[var(--color-neon-blue)]">
              {priceInfo.label}
            </span>
          )}
        </div>
        <TickRangeBar
          currentTick={liveCurrentTick}
          tickLower={pool?.liveData?.tickLower}
          tickUpper={pool?.liveData?.tickUpper}
          token0={pool?.token0}
          token1={pool?.token1}
          className="py-4"
        />
        <div className="flex justify-between text-xs text-[var(--color-text-tertiary)]">
          <span>Lower: {priceInfo.lower} {pool?.token0?.symbol ?? ''}</span>
          <span className="text-[var(--color-neon-blue)] font-semibold">
            Current: {priceInfo.current}
          </span>
          <span>Upper: {priceInfo.upper} {pool?.token0?.symbol ?? ''}</span>
        </div>

        {/* Pool Liquidity Indicator */}
        {(poolBal0 !== null || poolBal1 !== null) && (
          <div className="flex gap-4 pt-2 border-t border-[var(--color-border)]">
            <div className="flex items-center gap-2 text-xs">
              <span className={`w-2 h-2 rounded-full ${pool0Empty ? 'bg-[var(--color-status-danger)]' : 'bg-[var(--color-neon-green)]'}`} />
              <span className="text-[var(--color-text-tertiary)]">
                Pool {pool?.token0?.symbol}: {poolBal0 !== null ? (pool0Empty ? '⚠ Empty' : parseFloat(pool.liveData?.poolBalance0 ?? '0').toFixed(4)) : '—'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className={`w-2 h-2 rounded-full ${pool1Empty ? 'bg-[var(--color-status-danger)]' : 'bg-[var(--color-neon-green)]'}`} />
              <span className="text-[var(--color-text-tertiary)]">
                Pool {pool?.token1?.symbol}: {poolBal1 !== null ? (pool1Empty ? '⚠ Empty' : parseFloat(pool.liveData?.poolBalance1 ?? '0').toFixed(4)) : '—'}
              </span>
            </div>
          </div>
        )}
      </GlassCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Whale Swap Simulator ────────────────────────────────── */}
        <GlassCard className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="text-2xl">🐋</span>
            Whale Swap Simulator
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Execute a swap to push the price and trigger Somnia Reactivity rebalancing.
          </p>

          {/* Direction toggle */}
          <div className="flex rounded-xl overflow-hidden border border-[var(--color-border)]">
            {(['0to1', '1to0'] as const).map((dir) => (
              <button
                key={dir}
                onClick={() => setSwapDirection(dir)}
                className={`flex-1 py-2.5 text-sm font-medium transition-all cursor-pointer ${
                  swapDirection === dir
                    ? 'bg-[var(--color-neon-blue)]/10 text-[var(--color-neon-blue)]'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {dir === '0to1'
                  ? `${pool?.token0?.symbol ?? '0'} → ${pool?.token1?.symbol ?? '1'}`
                  : `${pool?.token1?.symbol ?? '1'} → ${pool?.token0?.symbol ?? '0'}`
                }
              </button>
            ))}
          </div>

          {/* Amount input */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-[var(--color-text-tertiary)]">Swap Amount</label>
              {userBalance !== null && (
                <span className="text-xs text-[var(--color-text-tertiary)]">
                  Balance: {userBalance.toFixed(4)} {swapDirection === '0to1' ? pool?.token0?.symbol : pool?.token1?.symbol}
                </span>
              )}
            </div>
            <input
              type="number"
              value={swapAmount}
              onChange={(e) => setSwapAmount(e.target.value)}
              min="0"
              step="0.1"
              className={`w-full px-4 py-3 rounded-xl bg-[var(--color-bg-input)] border text-sm font-mono text-[var(--color-text-primary)] focus:outline-none transition-colors ${
                insufficientBalance
                  ? 'border-[var(--color-status-danger)]/60 focus:border-[var(--color-status-danger)]'
                  : 'border-[var(--color-border)] focus:border-[var(--color-neon-blue)]/40'
              }`}
            />
            {insufficientBalance && (
              <p className="text-xs text-[var(--color-status-danger)] mt-1">
                ⚠ Insufficient balance. You have {userBalance?.toFixed(4)} but trying to swap {swapAmount}.
              </p>
            )}
          </div>

          {/* Liquidity warning */}
          {swapOutputEmpty && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--color-status-danger)]/10 border border-[var(--color-status-danger)]/20 text-xs text-[var(--color-status-danger)]">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>Pool has no {swapOutputToken} liquidity. This swap will revert (STF error).</span>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleApproveAndSwap}
              disabled={isApproveSwapLoading || isApproveSwapSuccess || insufficientBalance || !userAddress}
              className="flex-1 py-3 rounded-xl bg-[var(--color-neon-blue)]/10 text-[var(--color-neon-blue)] border border-[var(--color-neon-blue)]/20 font-semibold text-sm hover:bg-[var(--color-neon-blue)]/20 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-1.5"
            >
              {isApproveSwapLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {isApproveSwapSuccess ? '✓ Approved' : 'Approve'}
            </button>
            <button
              onClick={handleExecuteSwap}
              disabled={!isApproveSwapSuccess || isSwapLoading || swapOutputEmpty || insufficientBalance}
              className="flex-1 py-3 rounded-xl bg-gradient-to-r from-[var(--color-neon-pink)] to-[var(--color-neon-purple)] text-white font-bold text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-1.5"
            >
              {isSwapLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>💣</span>}
              {isSwapLoading ? 'Swapping...' : 'Execute Swap'}
            </button>
          </div>

          {!userAddress && (
            <p className="text-xs text-[var(--color-text-tertiary)] text-center">
              Connect your wallet to swap
            </p>
          )}

          {isSwapSuccess && (
            <div className="p-3 rounded-xl bg-[var(--color-neon-green)]/5 border border-[var(--color-neon-green)]/20 text-sm text-[var(--color-neon-green)]">
              ✅ Swap executed! Watch for reactivity rebalance below...
            </div>
          )}
        </GlassCard>

        {/* ── Rebalance Event Log ────────────────────────────────── */}
        <GlassCard className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="w-5 h-5 text-[var(--color-neon-green)]" />
            Rebalance Events
          </h2>

          {(!pool?.recentRebalances || pool.recentRebalances.length === 0) ? (
            <div className="text-center py-8 text-[var(--color-text-tertiary)]">
              <RefreshCw className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No rebalances yet</p>
              <p className="text-xs mt-1">Execute a swap to trigger one!</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {pool.recentRebalances.map((rb, i) => (
                <div
                  key={rb.txHash ?? `${rb.blockNumber}-${i}`}
                  className={`p-3 rounded-xl bg-[var(--color-bg-input)] border border-[var(--color-border)] text-sm space-y-1 ${i === 0 ? 'rebalance-flash' : ''}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-semibold text-[var(--color-neon-green)]">
                      ⚡ {rebalancePriceLabel(rb.newTick)}
                    </span>
                    <span className="text-xs text-[var(--color-text-tertiary)]">
                      {formatTimestamp(rb.timestamp)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-[var(--color-text-tertiary)]">
                    <span>LP NFT renewed (#{rb.oldTokenId?.toString()} → #{rb.newTokenId?.toString()})</span>
                    {rb.txHash && (
                      <a href={`${EXPLORER_URL}/tx/${rb.txHash}`} target="_blank" rel="noreferrer" className="text-[var(--color-neon-blue)] hover:underline flex items-center gap-1">
                        {formatAddress(rb.txHash)} <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </GlassCard>
      </div>

      {/* ── Owner Admin Panel ─────────────────────────────────────── */}
      {isOwner && (
        <GlassCard className="space-y-4" glow="blue">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Shield className="w-5 h-5 text-[var(--color-neon-blue)]" />
            Vault Admin
            <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-neon-blue)]/10 text-[var(--color-neon-blue)]">Owner</span>
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              onClick={handleStartWatching}
              disabled={watching || isStartWatchLoading}
              className="py-3 rounded-xl bg-[var(--color-neon-green)]/10 text-[var(--color-neon-green)] border border-[var(--color-neon-green)]/20 font-semibold text-sm hover:bg-[var(--color-neon-green)]/20 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
            >
              {isStartWatchLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
              Start Watching (3M gas)
            </button>
            <button
              onClick={handleStopWatching}
              disabled={!watching || isStopWatchLoading}
              className="py-3 rounded-xl bg-[var(--color-status-danger)]/10 text-[var(--color-status-danger)] border border-[var(--color-status-danger)]/20 font-semibold text-sm hover:bg-[var(--color-status-danger)]/20 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
            >
              {isStopWatchLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <EyeOff className="w-4 h-4" />}
              Stop Watching
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs text-[var(--color-text-tertiary)]">
            <div className="glass p-3 rounded-xl">
              <p>Subscription ID</p>
              <p className="font-mono text-[var(--color-text-primary)] mt-0.5">{subscriptionId?.toString() ?? '—'}</p>
            </div>
            <div className="glass p-3 rounded-xl">
              <p>Backup Sub ID</p>
              <p className="font-mono text-[var(--color-text-primary)] mt-0.5">{backupSubId?.toString() ?? '—'}</p>
            </div>
          </div>
        </GlassCard>
      )}
    </div>
  )
}
