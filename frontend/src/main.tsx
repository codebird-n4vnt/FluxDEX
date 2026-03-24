import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { config } from './config/WagmiConfig'
import App from './App.tsx'
import '@rainbow-me/rainbowkit/styles.css'
import './index.css'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: '#00d4ff',
            accentColorForeground: '#06080f',
            borderRadius: 'medium',
            fontStack: 'system',
            overlayBlur: 'small',
          })}
        >
          <BrowserRouter>
            <App />
            <Toaster
              position="bottom-right"
              toastOptions={{
                duration: 5000,
                style: {
                  background: 'rgba(15, 20, 40, 0.9)',
                  color: '#e8ecf4',
                  border: '1px solid rgba(0, 212, 255, 0.2)',
                  backdropFilter: 'blur(20px)',
                  borderRadius: '12px',
                  fontFamily: "'Inter', sans-serif",
                },
              }}
            />
          </BrowserRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)