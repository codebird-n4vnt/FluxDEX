import { defineChain, createPublicClient, createWalletClient, http } from 'viem'
import { SDK } from '@somnia-chain/reactivity'

export const somniaTestnet = defineChain({
  id: 50312,
  name: 'Somnia Testnet',
  nativeCurrency: { name: 'STT', symbol: 'STT', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://api.infra.testnet.somnia.network'],
      webSocket: ['wss://api.infra.testnet.somnia.network/ws']
    }
  },
  blockExplorers: {
    default: { name: 'Somnia Explorer', url: 'https://shannon-explorer.somnia.network' }
  }
})

export const publicClient = createPublicClient({
  chain: somniaTestnet,
  transport: http()
})

// Optional: Wallet client for on-chain writes
export const walletClient = createWalletClient({
  chain: somniaTestnet,
  transport: http()
})

export const sdk = new SDK({
  public: publicClient,
  wallet: walletClient // omit if not executing on-chain transactions
})