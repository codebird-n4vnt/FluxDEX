import { useMemo } from 'react'
import { tickToPrice, formatPrice } from '../../lib/priceUtils'
import type { Token } from '../../types'

interface TickRangeBarProps {
  currentTick?: number
  tickLower?: number
  tickUpper?: number
  token0?: Token
  token1?: Token
  className?: string
  showLabels?: boolean
}

export default function TickRangeBar({
  currentTick,
  tickLower,
  tickUpper,
  token0,
  token1,
  className = '',
  showLabels = true,
}: TickRangeBarProps) {
  const { position, color } = useMemo(() => {
    if (tickLower == null || tickUpper == null || currentTick == null) {
      return { position: 50, status: 'unknown' as const, color: 'var(--color-text-tertiary)' }
    }

    const range = tickUpper - tickLower
    if (range === 0) return { position: 50, status: 'in-range' as const, color: 'var(--color-neon-green)' }

    const raw = ((currentTick - tickLower) / range) * 100
    const clamped = Math.max(-10, Math.min(110, raw))

    let status: 'in-range' | 'near-edge' | 'out-of-range'
    let color: string

    if (raw < 0 || raw >= 100) {
      status = 'out-of-range'
      color = 'var(--color-status-danger)'
    } else if (raw < 10 || raw > 90) {
      status = 'near-edge'
      color = 'var(--color-neon-amber)'
    } else {
      status = 'in-range'
      color = 'var(--color-neon-green)'
    }

    return { position: clamped, status, color }
  }, [currentTick, tickLower, tickUpper])

  // Convert ticks to prices if token metadata is available
  const labels = useMemo(() => {
    const canConvert = token0 && token1 && token0.decimals != null && token1.decimals != null

    if (canConvert && tickLower != null) {
      const priceLower = tickToPrice(tickLower, token0.decimals, token1.decimals)
      const priceUpper = tickUpper != null ? tickToPrice(tickUpper, token0.decimals, token1.decimals) : null
      const priceCurrent = currentTick != null ? tickToPrice(currentTick, token0.decimals, token1.decimals) : null

      return {
        lower: formatPrice(priceLower),
        upper: priceUpper != null ? formatPrice(priceUpper) : '—',
        current: priceCurrent != null ? formatPrice(priceCurrent) : '—',
        suffix: `${token0.symbol}/${token1.symbol}`,
      }
    }

    // Fallback: show raw ticks
    return {
      lower: tickLower?.toLocaleString() ?? '—',
      upper: tickUpper?.toLocaleString() ?? '—',
      current: currentTick?.toLocaleString() ?? '—',
      suffix: '',
    }
  }, [currentTick, tickLower, tickUpper, token0, token1])

  return (
    <div className={`w-full ${className}`}>
      {/* Bar container */}
      <div className="relative h-3 rounded-full bg-[var(--color-bg-input)] overflow-visible">
        {/* Active range gradient fill */}
        <div
          className="absolute inset-y-0 rounded-full transition-all duration-500"
          style={{
            left: '0%',
            right: '0%',
            background: `linear-gradient(90deg, var(--color-neon-blue) 0%, var(--color-neon-green) 50%, var(--color-neon-blue) 100%)`,
            opacity: 0.2,
          }}
        />

        {/* Current tick marker */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 transition-all duration-700 ease-out"
          style={{ left: `${position}%` }}
        >
          {/* Glow ring */}
          <div
            className="w-5 h-5 rounded-full animate-pulse-glow"
            style={{
              background: `radial-gradient(circle, ${color} 0%, transparent 70%)`,
              color: color,
            }}
          />
          {/* Solid dot */}
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-[var(--color-bg-primary)]"
            style={{ background: color }}
          />
        </div>

        {/* Bounds markers */}
        <div className="absolute top-0 bottom-0 left-0 w-0.5 bg-[var(--color-neon-blue)]/30 rounded-full" />
        <div className="absolute top-0 bottom-0 right-0 w-0.5 bg-[var(--color-neon-blue)]/30 rounded-full" />
      </div>

      {/* Labels — prices instead of raw ticks */}
      {showLabels && (
        <div className="flex justify-between mt-1.5 text-[10px] font-mono text-[var(--color-text-tertiary)]">
          <span>{labels.lower}</span>
          <span style={{ color }} className="font-semibold">
            {labels.current}
          </span>
          <span>{labels.upper}</span>
        </div>
      )}
    </div>
  )
}
