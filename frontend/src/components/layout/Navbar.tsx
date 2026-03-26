import { Link, useLocation } from 'react-router-dom'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { Activity, Plus, LayoutDashboard, Zap } from 'lucide-react'
import socket from '../../lib/socket'
import { useState, useEffect } from 'react'

export default function Navbar() {
  const location = useLocation()
  const [isSocketConnected, setIsSocketConnected] = useState(socket.connected)

  useEffect(() => {
    const onConnect = () => setIsSocketConnected(true)
    const onDisconnect = () => setIsSocketConnected(false)
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
    }
  }, [])

  const navItems = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/create', label: 'Create Vault', icon: Plus },
  ]

  return (
    <nav className="glass sticky top-0 z-50 border-b border-[var(--color-border)] rounded-none">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2 no-underline group">
            <div className="relative">
              <Zap className="w-8 h-8 text-[var(--color-neon-blue)] group-hover:drop-shadow-[0_0_8px_rgba(0,212,255,0.6)] transition-all" />
            </div>
            <span className="text-xl font-bold gradient-text tracking-tight">
              FluxDEX
            </span>
          </Link>

          {/* Nav Links */}
          <div className="hidden sm:flex items-center gap-1">
            {navItems.map(({ to, label, icon: Icon }) => {
              const isActive = location.pathname === to
              return (
                <Link
                  key={to}
                  to={to}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium no-underline transition-all duration-200
                    ${isActive
                      ? 'bg-[var(--color-neon-blue)]/10 text-[var(--color-neon-blue)] border border-[var(--color-neon-blue)]/20'
                      : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-white/5'
                    }`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </Link>
              )
            })}
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3">
            {/* Socket status */}
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 text-xs font-medium">
              <span className={`w-2 h-2 rounded-full ${isSocketConnected
                ? 'bg-[var(--color-neon-green)] animate-pulse-glow'
                : 'bg-[var(--color-status-danger)]'
              }`} style={{ color: isSocketConnected ? 'var(--color-neon-green)' : 'var(--color-status-danger)' }} />
              <span className="text-[var(--color-text-secondary)]">
                {isSocketConnected ? 'Live' : 'Offline'}
              </span>
              {isSocketConnected && (
                <Activity className="w-3 h-3 text-[var(--color-neon-green)]" />
              )}
            </div>

            {/* RainbowKit Connect */}
            <ConnectButton
              chainStatus="icon"
              accountStatus="address"
              showBalance={false}
            />
          </div>
        </div>
      </div>

      {/* Mobile nav */}
      <div className="sm:hidden flex items-center gap-1 px-4 pb-3">
        {navItems.map(({ to, label, icon: Icon }) => {
          const isActive = location.pathname === to
          return (
            <Link
              key={to}
              to={to}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium no-underline flex-1 justify-center transition-all
                ${isActive
                  ? 'bg-[var(--color-neon-blue)]/10 text-[var(--color-neon-blue)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
