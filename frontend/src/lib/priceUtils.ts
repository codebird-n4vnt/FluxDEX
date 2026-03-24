// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — priceUtils.ts  (frontend)
// ─────────────────────────────────────────────────────────────────────────────

import { formatUnits } from "viem";
import type { Token } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// Known stablecoin addresses on Somnia Testnet (lowercase)
const STABLECOIN_ADDRESSES = new Set([
  "0x28bec7e30e6faee657a03e19bf1128aad7632a00", // USDC
]);

const STABLECOIN_SYMBOLS = new Set([
  "USDC", "USDT", "DAI", "FRAX"
]);

// Uniswap V3 tick math constant: price = 1.0001^tick
const LOG_BASE = Math.log(1.0001);

// Minimum STT balance before showing a warning in the UI
const STT_WARNING_THRESHOLD = 5; // STT

// ─────────────────────────────────────────────────────────────────────────────
//  CORE PRICE MATH
// ─────────────────────────────────────────────────────────────────────────────

export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint | string | number | undefined, token0Decimals: number, token1Decimals: number): number {
  if (!sqrtPriceX96) return 0;
  const val = BigInt(sqrtPriceX96);
  if (val === 0n) return 0;

  const Q96 = 2n ** 96n;

  const sqrtPrice = Number(val) / Number(Q96);
  const priceRaw  = sqrtPrice * sqrtPrice;

  if (priceRaw === 0) return 0;

  const decimalShift = Math.pow(10, token1Decimals - token0Decimals);
  return (1 / priceRaw) * decimalShift;
}

export function tickToPrice(tick: number, token0Decimals: number, token1Decimals: number): number {
  const rawPrice     = Math.pow(1.0001, tick);
  const decimalShift = Math.pow(10, token0Decimals - token1Decimals);
  return (1 / rawPrice) * decimalShift;
}

export function priceToTick(price: number, token0Decimals: number, token1Decimals: number, tickSpacing: number = 1): number {
  if (price <= 0) return 0;
  const decimalShift = Math.pow(10, token1Decimals - token0Decimals);
  const rawPrice = 1 / (price * decimalShift);
  const tick     = Math.log(rawPrice) / LOG_BASE;
  return Math.round(tick / tickSpacing) * tickSpacing;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TICK RANGE POSITION
// ─────────────────────────────────────────────────────────────────────────────

export function getTickRangePosition(currentTick: number, tickLower: number, tickUpper: number): number {
  if (tickUpper === tickLower) return 50; 
  return ((currentTick - tickLower) / (tickUpper - tickLower)) * 100;
}

export function getTickRangeStatus(position: number): "in-range" | "near-edge" | "out-of-range" {
  if (position < 0 || position >= 100) return "out-of-range";
  if (position < 10 || position > 90)  return "near-edge";
  return "in-range";
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRICE FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

interface FormatPriceOpts {
  compact?: boolean;
}

export function formatPrice(price: number | undefined | null, { compact = false }: FormatPriceOpts = {}): string {
  if (price === undefined || price === null || isNaN(price) || !isFinite(price)) return "—";

  if (compact && price >= 1_000_000) {
    return (price / 1_000_000).toFixed(2) + "M";
  }
  if (compact && price >= 1_000) {
    return (price / 1_000).toFixed(2) + "K";
  }

  if (price >= 1000)  return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1)     return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (price >= 0.001) return price.toFixed(6);
  return price.toExponential(4);
}

export function getPriceLabel(price: number | undefined, token0: Token | undefined, token1: Token | undefined): string {
  if (!price || !token0 || !token1) return "—";

  const formatted = formatPrice(price);

  if (isStablecoin(token0.address, token0.symbol)) {
    return `1 ${token1.symbol} = $${formatted}`;
  }

  if (isStablecoin(token1.address, token1.symbol)) {
    const inverted = price > 0 ? 1 / price : 0;
    return `1 ${token0.symbol} = $${formatPrice(inverted)}`;
  }

  return `1 ${token1.symbol} = ${formatted} ${token0.symbol}`;
}

export function getTickPriceLabel(tick: number, token0: Token, token1: Token): string {
  const price = tickToPrice(tick, token0.decimals, token1.decimals);
  if (isStablecoin(token0.address, token0.symbol)) {
    return `$${formatPrice(price)}`;
  }
  return formatPrice(price);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRICE IMPACT
// ─────────────────────────────────────────────────────────────────────────────

export function getPriceImpact(amountIn: number, reserveIn: number, feePct: number = 0.003): number {
  if (!amountIn || !reserveIn || reserveIn === 0) return 0;
  const amountInWithFee = amountIn * (1 - feePct);
  return (amountInWithFee / (reserveIn + amountInWithFee)) * 100;
}

export function getPriceImpactColor(impactPct: number): "text-secondary" | "text-yellow" | "text-red" {
  if (impactPct >= 5) return "text-red";
  if (impactPct >= 1) return "text-yellow";
  return "text-secondary";
}

export function formatPriceImpact(impactPct: number): string {
  if (impactPct < 0.01) return "<0.01%";
  return `${impactPct.toFixed(2)}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOKEN & FEE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export function isStablecoin(address?: string, symbol?: string): boolean {
  if (symbol && STABLECOIN_SYMBOLS.has(symbol.toUpperCase())) return true;
  if (address && STABLECOIN_ADDRESSES.has(address.toLowerCase())) return true;
  return false;
}

export function formatFeeTier(fee: number | undefined): string {
  if (!fee) return "—";
  return `${(fee / 10000).toFixed(2).replace(/\.?0+$/, "")}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  STT BALANCE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export function formatSTT(rawBalance: bigint | string | undefined): string {
  if (!rawBalance) return "0 STT";
  const formatted = parseFloat(formatUnits(BigInt(rawBalance), 18));
  return `${formatted.toFixed(2)} STT`;
}

export function isLowSTT(sttBalance: string | number): boolean {
  return parseFloat(sttBalance.toString()) < STT_WARNING_THRESHOLD;
}

export function isCriticalSTT(sttBalance: string | number): boolean {
  return parseFloat(sttBalance.toString()) < 32;
}