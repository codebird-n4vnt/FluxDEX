// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — formatUtils.ts  (frontend)
// ─────────────────────────────────────────────────────────────────────────────

import { formatUnits } from "viem";
import type { Token } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
//  ADDRESS FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

interface AddressOpts {
  leading?: number;
  trailing?: number;
}

export function formatAddress(address: string | undefined | null, { leading = 6, trailing = 4 }: AddressOpts = {}): string {
  if (!address || address.length < leading + trailing + 2) return address ?? "—";
  return `${address.slice(0, leading + 2)}...${address.slice(-trailing)}`;
}

export function formatTxHash(txHash: string | undefined): string {
  return formatAddress(txHash, { leading: 6, trailing: 4 });
}

// ─────────────────────────────────────────────────────────────────────────────
//  TICK FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

interface TickOpts {
  showSign?: boolean;
}

export function formatTick(tick: number | undefined | null, { showSign = true }: TickOpts = {}): string {
  if (tick === undefined || tick === null || isNaN(tick)) return "—";

  const abs       = Math.abs(tick);
  const formatted = abs.toLocaleString("en-US");

  if (!showSign) return tick < 0 ? `-${formatted}` : formatted;
  if (tick > 0)  return `+${formatted}`;
  if (tick < 0)  return `-${formatted}`;
  return "0";
}

export function formatTickRange(tickLower: number | undefined, tickUpper: number | undefined): string {
  return `${formatTick(tickLower)} → ${formatTick(tickUpper)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  NUMBER FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

interface AmountOpts {
  maxDecimals?: number;
  trimZeros?: boolean;
}

export function formatAmount(amount: number | string | undefined, { maxDecimals = 6, trimZeros = true }: AmountOpts = {}): string {
  if (amount === undefined) return "0";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  
  if (isNaN(num) || !isFinite(num)) return "0";
  if (num === 0) return "0";

  let decimals: number;
  if      (num >= 1_000_000) decimals = 2;
  else if (num >= 1_000)     decimals = 2;
  else if (num >= 1)         decimals = 4;
  else if (num >= 0.001)     decimals = 6;
  else                       decimals = 8;

  decimals = Math.min(decimals, maxDecimals);

  const formatted = num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });

  if (trimZeros) {
    return formatted.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }

  return formatted;
}

export function formatAmountCompact(amount: number | string | undefined): string {
  if (amount === undefined) return "0";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return "0";

  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000)     return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000)         return `${(num / 1_000).toFixed(2)}K`;
  return formatAmount(num);
}

interface USDOpts {
  compact?: boolean;
}

export function formatUSD(amount: number | undefined | null, { compact = false }: USDOpts = {}): string {
  if (amount === undefined || amount === null || isNaN(amount)) return "$—";

  if (compact) {
    return `$${formatAmountCompact(amount)}`;
  }

  return amount.toLocaleString("en-US", {
    style:                 "currency",
    currency:              "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

interface TokenAmountOpts {
  displayDecimals?: number;
}

export function formatTokenAmount(rawAmount: bigint | string | undefined, decimals: number, { displayDecimals = 6 }: TokenAmountOpts = {}): string {
  if (!rawAmount) return "0";
  try {
    const human = parseFloat(formatUnits(BigInt(rawAmount), decimals));
    return formatAmount(human, { maxDecimals: displayDecimals });
  } catch {
    return "0";
  }
}

export function formatLiquidity(liquidity: bigint | number | string | undefined): string {
  if (liquidity === undefined) return "0";
  return formatAmountCompact(Number(liquidity));
}

// ─────────────────────────────────────────────────────────────────────────────
//  TIME FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

export function formatTimestamp(timestamp: number | undefined): string {
  if (!timestamp) return "—";

  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 5)   return "just now";
  if (seconds < 60)  return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)  return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24)    return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatBlockNumber(blockNumber: number | bigint | undefined): string {
  if (!blockNumber) return "—";
  return Number(blockNumber).toLocaleString("en-US");
}

// ─────────────────────────────────────────────────────────────────────────────
//  POOL / TOKEN HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export function getPoolName(token0: Token | undefined, token1: Token | undefined): string {
  if (!token0 || !token1) return "Unknown Pool";
  return `${token0.symbol} / ${token1.symbol}`;
}

export function getPoolKey(poolAddress: string | undefined): string {
  return poolAddress?.toLowerCase() ?? "unknown";
}

export function getFeeTierLabel(fee: number | undefined): string {
  if (!fee) return "—";
  const pct = fee / 10_000;
  return `${pct.toFixed(2).replace(/\.?0+$/, "")}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  STRING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export function truncateString(str: string | undefined, maxLength: number = 20): string {
  if (!str || str.length <= maxLength) return str ?? "";
  return `${str.slice(0, maxLength)}...`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}