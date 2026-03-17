// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — chain.js  (frontend)
//  Viem public client + contract read helpers for the Somnia Testnet.
//
//  What this file provides:
//    1. somniaTestnet      — chain definition for viem + RainbowKit
//    2. publicClient       — HTTP client for all on-chain reads
//    3. CONTRACTS          — deployed contract addresses from .env
//    4. readVaultConfig()  — reads vault.config() in one call
//    5. readPoolSlot0()    — reads pool.slot0() in one call
//    6. readVaultFull()    — reads vault + pool data in one batched call
//    7. getExplorerUrl()   — builds Somnia explorer links
//
//  The frontend does NOT use the WSS client directly.
//  All live event data comes from the backend via Socket.io.
//  The public HTTP client is only used for:
//    • Wallet-triggered writes (approve, swap) — viem wagmi handles this
//    • One-off reads when Socket.io data is stale or unavailable
// ─────────────────────────────────────────────────────────────────────────────

import { createPublicClient, defineChain, http } from "viem";
import { VAULT_ABI, POOL_ABI, ERC20_ABI }        from "./abis.js";

// ─────────────────────────────────────────────────────────────────────────────
//  CHAIN DEFINITION
//  Used by both viem's publicClient and RainbowKit's wallet modal.
//  Must match the chain definition in the backend exactly.
// ─────────────────────────────────────────────────────────────────────────────

export const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: {
    name:     "STT",
    symbol:   "STT",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http:      [import.meta.env.VITE_RPC_URL ?? "https://api.infra.testnet.somnia.network"],
      webSocket: [import.meta.env.VITE_WSS_URL ?? "wss://api.infra.testnet.somnia.network/ws"],
    },
  },
  blockExplorers: {
    default: {
      name: "Somnia Explorer",
      url:  "https://shannon-explorer.somnia.network",
    },
  },
  // testnet: true tells RainbowKit to show the testnet badge
  testnet: true,
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC CLIENT
//  Used for direct on-chain reads from the frontend.
//  For wallet-connected writes, use the walletClient from wagmi/RainbowKit.
// ─────────────────────────────────────────────────────────────────────────────

export const publicClient = createPublicClient({
  chain:     somniaTestnet,
  transport: http(
    import.meta.env.VITE_RPC_URL ?? "https://api.infra.testnet.somnia.network"
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
//  DEPLOYED CONTRACT ADDRESSES
//  Set these in your frontend .env file:
//    VITE_FACTORY_ADDRESS=0x...
//    VITE_NPM_ADDRESS=0x...
// ─────────────────────────────────────────────────────────────────────────────

export const CONTRACTS = {
  factory: import.meta.env.VITE_FACTORY_ADDRESS,
  npm:     import.meta.env.VITE_NPM_ADDRESS,
};

// ─────────────────────────────────────────────────────────────────────────────
//  KNOWN TOKEN ADDRESSES  (Somnia Testnet)
// ─────────────────────────────────────────────────────────────────────────────



// ─────────────────────────────────────────────────────────────────────────────
//  READ HELPERS
//  Thin wrappers around publicClient.readContract.
//  Used when you need a fresh on-chain read outside of the Socket.io data flow
//  (e.g. after a user submits a swap to confirm the new price immediately).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads vault.config() — returns the full packed VaultConfig struct.
 *
 * @param   {string} vaultAddress
 * @returns {Promise<{
 *   tickLower:   number,
 *   tickUpper:   number,
 *   halfWidth:   number,
 *   tickSpacing: number,
 *   poolFee:     number,
 *   initialized: boolean,
 *   watching:    boolean,
 * }>}
 */
export async function readVaultConfig(vaultAddress) {
  const result = await publicClient.readContract({
    address:      vaultAddress,
    abi:          VAULT_ABI,
    functionName: "config",
  });

  return {
    tickLower:   Number(result[0]),
    tickUpper:   Number(result[1]),
    halfWidth:   Number(result[2]),
    tickSpacing: Number(result[3]),
    poolFee:     Number(result[4]),
    initialized: result[5],
    watching:    result[6],
  };
}

/**
 * Reads pool.slot0() — returns current tick and sqrtPriceX96.
 *
 * @param   {string} poolAddress
 * @returns {Promise<{
 *   sqrtPriceX96: bigint,
 *   tick:         number,
 *   unlocked:     boolean,
 * }>}
 */
export async function readPoolSlot0(poolAddress) {
  const result = await publicClient.readContract({
    address:      poolAddress,
    abi:          POOL_ABI,
    functionName: "slot0",
  });

  return {
    sqrtPriceX96: result[0],   // bigint
    tick:         Number(result[1]),
    unlocked:     result[6],
  };
}

/**
 * Reads vault STT balance.
 *
 * @param   {string} vaultAddress
 * @returns {Promise<bigint>}  — raw wei value
 */
export async function readVaultSTTBalance(vaultAddress) {
  return publicClient.readContract({
    address:      vaultAddress,
    abi:          VAULT_ABI,
    functionName: "sttBalance",
  });
}

/**
 * Reads ERC-20 token allowance.
 * Used before swap to check if approval is needed.
 *
 * @param   {string} tokenAddress
 * @param   {string} ownerAddress
 * @param   {string} spenderAddress
 * @returns {Promise<bigint>}
 */
export async function readTokenAllowance(tokenAddress, ownerAddress, spenderAddress) {
  return publicClient.readContract({
    address:tokenAddress,
    abi:ERC20_ABI,
    functionName:"allowance",
    args:[ownerAddress, spenderAddress],
  });
}

/**
 * Reads ERC-20 token balance for an address.
 *
 * @param   {string} tokenAddress
 * @param   {string} walletAddress
 * @returns {Promise<bigint>}
 */
export async function readTokenBalance(tokenAddress, walletAddress) {
  return publicClient.readContract({
    address:      tokenAddress,
    abi:          ERC20_ABI,
    functionName: "balanceOf",
    args:         [walletAddress],
  });
}

/**
 * Batches vault config + pool slot0 into a single parallel read.
 * Use this to refresh all live data for a pool page in one go.
 *
 * @param   {string} vaultAddress
 * @param   {string} poolAddress
 * @returns {Promise<{ config: VaultConfig, slot0: Slot0 }>}
 */
export async function readVaultFull(vaultAddress, poolAddress) {
  const [config, slot0] = await Promise.all([
    readVaultConfig(vaultAddress),
    readPoolSlot0(poolAddress),
  ]);
  return { config, slot0 };
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXPLORER HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const EXPLORER_BASE = "https://shannon-explorer.somnia.network";

/**
 * Returns a Somnia Explorer URL for a transaction hash.
 * @param   {string} txHash
 * @returns {string}
 */
export function getExplorerTxUrl(txHash) {
  return `${EXPLORER_BASE}/tx/${txHash}`;
}

/**
 * Returns a Somnia Explorer URL for a contract or wallet address.
 * @param   {string} address
 * @returns {string}
 */
export function getExplorerAddressUrl(address) {
  return `${EXPLORER_BASE}/address/${address}`;
}
