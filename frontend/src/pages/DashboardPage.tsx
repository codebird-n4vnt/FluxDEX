import { useNavigate } from 'react-router-dom'
import { usePools } from '../hooks/usePools'
import GlassCard from '../components/ui/GlassCard'
import StatusBadge from '../components/ui/StatusBadge'
import TickRangeBar from '../components/ui/TickRangeBar'
import { formatAddress, formatTimestamp } from '../lib/formatUtils'
import { tickToPrice, formatPrice } from '../lib/priceUtils'
import { Zap, Shield, RefreshCw, Plus, ArrowRight, Activity, AlertTriangle } from 'lucide-react'

export default function DashboardPage() {
  const { pools, isLoading, isConnected, error } = usePools()
  const navigate = useNavigate()

  const totalVaults = pools.length
  const activeWatchers = pools.filter(p => p.liveData?.watching).length
  const totalRebalances = pools.reduce((acc, p) => acc + (p.recentRebalances?.length ?? 0), 0)

  return (
    <div className="space-y-8">
      {/* ── Hero Section ─────────────────────────────────────────────── */}
      <div className="text-center space-y-4 py-6">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
          <span className="gradient-text">FluxVault</span>
        </h1>
        <p className="text-[var(--color-text-secondary)] text-lg max-w-2xl mx-auto">
          JIT Liquidity Rebalancer powered by{' '}
          <span className="text-[var(--color-neon-blue)] font-semibold">Somnia Reactivity</span>.
          Automated concentrated liquidity management for Uniswap V3.
        </p>
      </div>

      {/* ── Stats Row ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <GlassCard className="text-center" glow="blue">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Shield className="w-5 h-5 text-[var(--color-neon-blue)]" />
            <span className="text-sm font-medium text-[var(--color-text-secondary)]">Total Vaults</span>
          </div>
          <p className="text-3xl font-bold text-[var(--color-text-primary)] font-mono">{totalVaults}</p>
        </GlassCard>

        <GlassCard className="text-center" glow="green">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Activity className="w-5 h-5 text-[var(--color-neon-green)]" />
            <span className="text-sm font-medium text-[var(--color-text-secondary)]">Active Watchers</span>
          </div>
          <p className="text-3xl font-bold text-[var(--color-neon-green)] font-mono">{activeWatchers}</p>
        </GlassCard>

        <GlassCard className="text-center" glow="pink">
          <div className="flex items-center justify-center gap-2 mb-2">
            <RefreshCw className="w-5 h-5 text-[var(--color-neon-pink)]" />
            <span className="text-sm font-medium text-[var(--color-text-secondary)]">Rebalances</span>
          </div>
          <p className="text-3xl font-bold text-[var(--color-neon-pink)] font-mono">{totalRebalances}</p>
        </GlassCard>
      </div>

      {/* ── Create Vault CTA ─────────────────────────────────────────── */}
      <GlassCard
        hover
        className="flex items-center justify-between cursor-pointer group"
        onClick={() => navigate('/create')}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--color-neon-blue)]/10 flex items-center justify-center">
            <Plus className="w-5 h-5 text-[var(--color-neon-blue)]" />
          </div>
          <div>
            <p className="font-semibold text-[var(--color-text-primary)]">Create New Vault</p>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Deploy a new pool + vault with automated JIT rebalancing
            </p>
          </div>
        </div>
        <ArrowRight className="w-5 h-5 text-[var(--color-text-tertiary)] group-hover:text-[var(--color-neon-blue)] group-hover:translate-x-1 transition-all" />
      </GlassCard>

      {/* ── Vault Grid ───────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-[var(--color-text-primary)]">
            Active Vaults
          </h2>
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-[var(--color-neon-green)]' : 'bg-[var(--color-status-danger)]'}`} />
            {isConnected ? 'Real-time updates' : 'Connecting...'}
          </div>
        </div>

        {isLoading && (
          <div className="text-center py-16 text-[var(--color-text-secondary)]">
            <Zap className="w-10 h-10 mx-auto mb-3 animate-pulse text-[var(--color-neon-blue)]" />
            <p>Loading vaults...</p>
          </div>
        )}

        {error && (
          <GlassCard className="text-center py-8">
            <p className="text-[var(--color-status-danger)]">⚠️ {error}</p>
            <p className="text-sm text-[var(--color-text-secondary)] mt-2">
              Make sure the backend indexer is running on port 3001
            </p>
          </GlassCard>
        )}

        {!isLoading && !error && pools.length === 0 && (
          <GlassCard className="text-center py-12">
            <Zap className="w-12 h-12 mx-auto mb-3 text-[var(--color-text-tertiary)]" />
            <p className="text-[var(--color-text-secondary)]">No vaults found.</p>
            <button
              onClick={() => navigate('/create')}
              className="mt-4 px-5 py-2.5 rounded-xl bg-[var(--color-neon-blue)] text-[var(--color-bg-primary)] font-semibold text-sm hover:opacity-90 transition-opacity cursor-pointer"
            >
              Create Your First Vault
            </button>
          </GlassCard>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {pools.map((pool) => {
            const watching = pool.liveData?.watching ?? false
            const initialized = pool.liveData?.initialized ?? false
            const status = watching ? 'watching' : initialized ? 'unprotected' : 'initializing'

            // Health checks
            const sttBalance = parseFloat(pool.liveData?.sttBalance ?? '0')
            const sttLow = sttBalance < 32
            const poolBal0 = pool.liveData?.poolBalance0 ? parseFloat(pool.liveData.poolBalance0) : null
            const poolBal1 = pool.liveData?.poolBalance1 ? parseFloat(pool.liveData.poolBalance1) : null
            const hasLiquidityIssue = (poolBal0 !== null && poolBal0 < 0.0001) || (poolBal1 !== null && poolBal1 < 0.0001)

            // In-range check
            const tick = pool.liveData?.currentTick
            const tL = pool.liveData?.tickLower
            const tU = pool.liveData?.tickUpper
            const outOfRange = tick != null && tL != null && tU != null && (tick < tL || tick >= tU)

            // Convert last rebalance tick to price
            const lastRebalance = pool.recentRebalances?.[0]
            let lastRebalanceLabel = ''
            if (lastRebalance && pool.token0 && pool.token1) {
              const price = tickToPrice(lastRebalance.newTick, pool.token0.decimals, pool.token1.decimals)
              lastRebalanceLabel = `${formatPrice(price)} ${pool.token0.symbol}/${pool.token1.symbol}`
            }

            return (
              <GlassCard
                key={pool.poolAddress}
                hover
                onClick={() => navigate(`/vault/${pool.poolAddress}`)}
                className="space-y-4 cursor-pointer"
              >
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[var(--color-neon-blue)] to-[var(--color-neon-purple)] flex items-center justify-center text-sm font-bold">
                      {pool.token0?.symbol?.charAt(0) ?? '?'}{pool.token1?.symbol?.charAt(0) ?? '?'}
                    </div>
                    <div>
                      <p className="font-semibold text-[var(--color-text-primary)]">
                        {pool.token0?.symbol ?? '???'} / {pool.token1?.symbol ?? '???'}
                      </p>
                      <p className="text-xs text-[var(--color-text-tertiary)] font-mono">
                        {formatAddress(pool.poolAddress)}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={status} />
                </div>

                {/* Health warnings */}
                {(sttLow || hasLiquidityIssue || outOfRange) && (
                  <div className="flex flex-wrap gap-1.5">
                    {sttLow && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--color-status-danger)]/10 text-[var(--color-status-danger)] text-[10px] font-medium">
                        <AlertTriangle className="w-3 h-3" />
                        Low STT ({sttBalance.toFixed(1)})
                      </span>
                    )}
                    {hasLiquidityIssue && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--color-neon-amber)]/10 text-[var(--color-neon-amber)] text-[10px] font-medium">
                        <AlertTriangle className="w-3 h-3" />
                        Low Liquidity
                      </span>
                    )}
                    {outOfRange && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--color-neon-amber)]/10 text-[var(--color-neon-amber)] text-[10px] font-medium">
                        <AlertTriangle className="w-3 h-3" />
                        Out of Range
                      </span>
                    )}
                  </div>
                )}

                {/* Live Data */}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-[var(--color-text-tertiary)] text-xs">Current Price</p>
                    <p className="font-mono font-medium text-[var(--color-text-primary)]">
                      {pool.liveData?.priceLabel ?? '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[var(--color-text-tertiary)] text-xs">Fee Tier</p>
                    <p className="font-mono font-medium text-[var(--color-text-primary)]">
                      {pool.fee ? `${pool.fee / 10000}%` : '—'}
                    </p>
                  </div>
                </div>

                {/* Tick Range — now with token props for price labels */}
                <TickRangeBar
                  currentTick={pool.liveData?.currentTick}
                  tickLower={pool.liveData?.tickLower}
                  tickUpper={pool.liveData?.tickUpper}
                  token0={pool.token0}
                  token1={pool.token1}
                />

                {/* Recent Activity — shows price instead of tick */}
                {lastRebalance && (
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 text-[var(--color-neon-green)]">
                      <Zap className="w-3.5 h-3.5" />
                      <span>Rebalanced: {lastRebalanceLabel}</span>
                    </div>
                    <span className="text-[var(--color-text-tertiary)]">
                      {formatTimestamp(lastRebalance.timestamp)}
                    </span>
                  </div>
                )}
              </GlassCard>
            )
          })}
        </div>
      </section>
    </div>
  )
}
