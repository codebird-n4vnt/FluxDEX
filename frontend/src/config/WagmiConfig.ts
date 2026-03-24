import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { defineChain, http } from 'viem'
import {
    braveWallet,
    injectedWallet,
    metaMaskWallet,
    phantomWallet,
    rainbowWallet,
  } from '@rainbow-me/rainbowkit/wallets';
import { createConfig } from 'wagmi';


export const somniaTestnet = defineChain({
  id: 50312,
  name: 'Somnia Testnet',
  nativeCurrency: { name: 'STT', symbol: 'STT', decimals: 18 },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_RPC_URL ?? 'https://api.infra.testnet.somnia.network'],
      webSocket: [import.meta.env.VITE_WSS_URL ?? 'wss://api.infra.testnet.somnia.network/ws'],
    },
  },
  blockExplorers: {
    default: { name: 'Somnia Explorer', url: 'https://shannon-explorer.somnia.network' },
  },
  testnet: true,
})

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Recommended',
      wallets: [metaMaskWallet,rainbowWallet,braveWallet,phantomWallet,injectedWallet],
    },
  ],
  {
    appName: 'FluxDEX',
    projectId:'a9c7776b598eede9f0879a073db4539d',
  }
);

export const config = createConfig({
  connectors,
  chains: [somniaTestnet],
  transports:{
    [somniaTestnet.id]:http(),
  }
})
