import { Outlet } from 'react-router-dom'
import Navbar from './Navbar'

export default function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>
      <footer className="border-t border-[var(--color-border)] py-6 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-[var(--color-text-tertiary)]">
            FluxVault — JIT Liquidity Rebalancer on Somnia Testnet
          </p>
          <div className="flex items-center gap-4 text-xs text-[var(--color-text-tertiary)]">
            <a
              href="https://docs.somnia.network/developer/reactivity"
              target="_blank"
              rel="noreferrer"
              className="hover:text-[var(--color-neon-blue)] transition-colors no-underline"
            >
              Somnia Reactivity Docs
            </a>
            <a
              href="https://shannon-explorer.somnia.network"
              target="_blank"
              rel="noreferrer"
              className="hover:text-[var(--color-neon-blue)] transition-colors no-underline"
            >
              Block Explorer
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
