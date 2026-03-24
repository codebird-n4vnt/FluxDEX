import { type ReactNode } from 'react'

interface GlassCardProps {
  children: ReactNode
  className?: string
  hover?: boolean
  glow?: 'blue' | 'green' | 'pink' | 'none'
  onClick?: () => void
}

export default function GlassCard({
  children,
  className = '',
  hover = false,
  glow = 'none',
  onClick,
}: GlassCardProps) {
  const glowClass = {
    blue: 'glow-blue',
    green: 'glow-green',
    pink: 'glow-pink',
    none: '',
  }[glow]

  return (
    <div
      className={`glass ${hover ? 'glass-hover cursor-pointer' : ''} ${glowClass} p-5 transition-all duration-300 ${className}`}
      onClick={onClick}
    >
      {children}
    </div>
  )
}
