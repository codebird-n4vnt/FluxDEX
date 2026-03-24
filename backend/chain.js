// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — chain.js
//  Viem public client setup for Somnia Testnet.
//  Exports HTTP client (always) and WSS client (lazy, resilient).
// ─────────────────────────────────────────────────────────────────────────────

import { createPublicClient, defineChain, http, webSocket } from "viem";

const RPC_URL = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const WSS_URL = process.env.WSS_URL || "wss://dream-rpc.somnia.network/ws";

// ── Somnia Testnet chain definition ──────────────────────────────────────────
export const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: {
      http:      [RPC_URL],
      webSocket: [WSS_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "Somnia Explorer",
      url:  "https://shannon-explorer.somnia.network",
    },
  },
});

// ── HTTP client — always available, used for all reads ────────────────────────
export const httpClient = createPublicClient({
  chain:     somniaTestnet,
  transport: http(RPC_URL),
});

// ── WSS client — created lazily with error resilience ─────────────────────────
let _wssClient = null;
let _wssAttempted = false;

export function getWssClient() {
  if (_wssClient) return _wssClient;
  if (_wssAttempted) return null; // don't retry after failure

  try {
    _wssClient = createPublicClient({
      chain:     somniaTestnet,
      transport: webSocket(WSS_URL),
    });
    console.log("[Chain] WSS client created:", WSS_URL);
    return _wssClient;
  } catch (err) {
    console.warn("[Chain] WSS client creation failed:", err.message);
    console.warn("[Chain] Will use HTTP polling only.");
    _wssAttempted = true;
    return null;
  }
}

// Backward compat — some files may import wssClient directly
// This creates it eagerly but safely
export const wssClient = (() => {
  try {
    return createPublicClient({
      chain:     somniaTestnet,
      transport: webSocket(WSS_URL),
    });
  } catch (err) {
    console.warn("[Chain] Eager WSS init failed, will use HTTP polling:", err.message);
    return null;
  }
})();
