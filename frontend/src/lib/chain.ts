// src/lib/chain.ts
import { createPublicClient, http } from "viem";
import { somniaTestnet } from "../config/WagmiConfig";
import { VAULT_ABI, POOL_ABI, ERC20_ABI } from "./abis";

export { somniaTestnet };

export const publicClient = createPublicClient({
  chain: somniaTestnet,
  transport: http(import.meta.env.VITE_RPC_URL ?? "https://api.infra.testnet.somnia.network"),
});

export const CONTRACTS = {
  factory: import.meta.env.VITE_FACTORY_ADDRESS as `0x${string}`,
  npm: import.meta.env.VITE_NPM_ADDRESS as `0x${string}`,
  router: import.meta.env.VITE_ROUTER_ADDRESS as `0x${string}`,
};

// ─────────────────────────────────────────────────────────────────────────────
// TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

export interface VaultConfig {
  tickLower: number;
  tickUpper: number;
  halfWidth: number;
  tickSpacing: number;
  poolFee: number;
  initialized: boolean;
  watching: boolean;
}

export interface PoolSlot0 {
  sqrtPriceX96: bigint;
  tick: number;
  unlocked: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// READ HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export async function readVaultConfig(vaultAddress: `0x${string}`): Promise<VaultConfig> {
  const result: any = await publicClient.readContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "config",
  });

  return {
    tickLower: Number(result[0]),
    tickUpper: Number(result[1]),
    halfWidth: Number(result[2]),
    tickSpacing: Number(result[3]),
    poolFee: Number(result[4]),
    initialized: result[5],
    watching: result[6],
  };
}

export async function readPoolSlot0(poolAddress: `0x${string}`): Promise<PoolSlot0> {
  const result: any = await publicClient.readContract({
    address: poolAddress,
    abi: POOL_ABI,
    functionName: "slot0",
  });

  return {
    sqrtPriceX96: result[0] as bigint,
    tick: Number(result[1]),
    unlocked: result[6] as boolean,
  };
}

export async function readVaultFull(
  vaultAddress: string, 
  poolAddress: string
): Promise<{ config: VaultConfig; slot0: PoolSlot0 }> {
  const [config, slot0] = await Promise.all([
    readVaultConfig(vaultAddress as `0x${string}`),
    readPoolSlot0(poolAddress as `0x${string}`),
  ]);
  return { config, slot0 };
}

export async function readVaultSTTBalance(vaultAddress: `0x${string}`): Promise<bigint> {
  const result = await publicClient.readContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "sttBalance",
  });
  return result as bigint;
}

export async function readTokenBalance(tokenAddress: `0x${string}`, walletAddress: `0x${string}`): Promise<bigint> {
  const result = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [walletAddress],
  });
  return result as bigint;
}