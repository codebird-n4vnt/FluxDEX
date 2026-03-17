// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — chain.js
//  Viem public client setup for Somnia Testnet.
//  Exports both HTTP client (for reads) and WSS client (for event subscriptions).
// ─────────────────────────────────────────────────────────────────────────────

import { createPublicClient, defineChain, http, webSocket } from "viem";

// ── Somnia Testnet chain definition ──────────────────────────────────────────
export const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: {
      http:      [process.env.RPC_URL || "https://api.infra.testnet.somnia.network"],
      webSocket: [process.env.WSS_URL || "wss://api.infra.testnet.somnia.network/ws"],
    },
  },
  blockExplorers: {
    default: {
      name: "Somnia Explorer",
      url:  "https://shannon-explorer.somnia.network",
    },
  },
});

// ── HTTP client — used for all read calls and event log fetching ──────────────
export const httpClient = createPublicClient({
  chain:     somniaTestnet,
  transport: http(process.env.RPC_URL),
});

// ── WSS client — used for live event subscriptions ───────────────────────────
// Somnia Reactivity docs: use WSS for real-time push delivery.
export const wssClient = createPublicClient({
  chain:     somniaTestnet,
  transport: webSocket(process.env.WSS_URL),
});
