interface StatusBadgeProps {
  status: 'watching' | 'unprotected' | 'initializing' | 'offline'
  label?: string
  size?: 'sm' | 'md'
}

const STATUS_CONFIG = {
  watching: {
    color: 'var(--color-neon-green)',
    bg: 'rgba(57, 255, 20, 0.1)',
    border: 'rgba(57, 255, 20, 0.25)',
    label: '🛡️ Protected',
    pulse: true,
  },
  unprotected: {
    color: 'var(--color-status-danger)',
    bg: 'rgba(239, 68, 68, 0.1)',
    border: 'rgba(239, 68, 68, 0.25)',
    label: '⚠️ Unprotected',
    pulse: false,
  },
  initializing: {
    color: 'var(--color-neon-amber)',
    bg: 'rgba(245, 158, 11, 0.1)',
    border: 'rgba(245, 158, 11, 0.25)',
    label: '⏳ Initializing',
    pulse: true,
  },
  offline: {
    color: 'var(--color-text-tertiary)',
    bg: 'rgba(74, 82, 112, 0.1)',
    border: 'rgba(74, 82, 112, 0.25)',
    label: '● Offline',
    pulse: false,
  },
}

export default function StatusBadge({ status, label, size = 'sm' }: StatusBadgeProps) {
  const cfg = STATUS_CONFIG[status]
  const sizeClass = size === 'sm' ? 'text-xs px-2.5 py-1' : 'text-sm px-3 py-1.5'

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${sizeClass}`}
      style={{
        color: cfg.color,
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
      }}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${cfg.pulse ? 'animate-pulse-glow' : ''}`}
        style={{ backgroundColor: cfg.color, color: cfg.color }}
      />
      {label ?? cfg.label}
    </span>
  )
}
