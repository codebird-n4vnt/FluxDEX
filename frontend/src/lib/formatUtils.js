// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — formatUtils.js  (frontend)
//  All display formatting utilities used across the UI.
//  Pure functions — no side effects, no imports from other FluxDEX files.
//
//  Functions exported:
//    formatAddress()       — "0x1234...abcd"
//    formatTick()          — "+1,247" / "-300"
//    formatAmount()        — "1,000.00" with token decimals
//    formatAmountCompact() — "1.84K" / "2.3M"
//    formatUSD()           — "$1,842.57"
//    formatTimestamp()     — "2 minutes ago"
//    formatBlockNumber()   — "12,345,678"
//    formatTxHash()        — "0xabcd...1234"
//    formatTokenAmount()   — converts raw bigint to human units
//    formatLiquidity()     — "1.23M" compact liquidity display
//    getFeeTierLabel()     — "0.3%" from fee number
//    getPoolName()         — "USDC / WETH" from token pair
//    getPoolKey()          — deterministic key for React lists
//    truncateString()      — generic string truncator
// ─────────────────────────────────────────────────────────────────────────────

import { formatUnits } from "viem";

// ─────────────────────────────────────────────────────────────────────────────
//  ADDRESS FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shortens an Ethereum address for display.
 * @param   {string}  address
 * @param   {object}  [opts]
 * @param   {number}  [opts.leading=6]   — chars to show after 0x
 * @param   {number}  [opts.trailing=4]  — chars to show at end
 * @returns {string}  e.g. "0x1234...abcd"
 */
export function formatAddress(address, { leading = 6, trailing = 4 } = {}) {
  if (!address || address.length < leading + trailing + 2) return address ?? "—";
  return `${address.slice(0, leading + 2)}...${address.slice(-trailing)}`;
}

/**
 * Shortens a transaction hash for display.
 * @param   {string} txHash
 * @returns {string}  e.g. "0xabcd...1234"
 */
export function formatTxHash(txHash) {
  return formatAddress(txHash, { leading: 6, trailing: 4 });
}

// ─────────────────────────────────────────────────────────────────────────────
//  TICK FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a Uniswap V3 tick for display.
 * Shows sign explicitly and uses locale separators for large values.
 *
 * @param   {number}  tick
 * @param   {object}  [opts]
 * @param   {boolean} [opts.showSign=true]  — always show + or - prefix
 * @returns {string}  e.g. "+1,247"  |  "-300"  |  "0"
 */
export function formatTick(tick, { showSign = true } = {}) {
  if (tick === undefined || tick === null || isNaN(tick)) return "—";

  const abs       = Math.abs(tick);
  const formatted = abs.toLocaleString("en-US");

  if (!showSign) return tick < 0 ? `-${formatted}` : formatted;
  if (tick > 0)  return `+${formatted}`;
  if (tick < 0)  return `-${formatted}`;
  return "0";
}

/**
 * Formats a tick range as a string.
 * @param   {number} tickLower
 * @param   {number} tickUpper
 * @returns {string}  e.g. "-600 → +600"
 */
export function formatTickRange(tickLower, tickUpper) {
  return `${formatTick(tickLower)} → ${formatTick(tickUpper)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  NUMBER FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a token amount with appropriate decimal places.
 * Adapts based on magnitude — large numbers get fewer decimals.
 *
 * @param   {number|string} amount
 * @param   {object}  [opts]
 * @param   {number}  [opts.maxDecimals=6]
 * @param   {boolean} [opts.trimZeros=true]  — remove trailing zeros
 * @returns {string}  e.g. "1,000.00"  |  "0.482341"  |  "0.000001"
 */
export function formatAmount(amount, { maxDecimals = 6, trimZeros = true } = {}) {
  const num = parseFloat(amount);
  if (isNaN(num) || !isFinite(num)) return "0";
  if (num === 0) return "0";

  let decimals;
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
    // Remove trailing zeros after decimal point
    return formatted.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }

  return formatted;
}

/**
 * Formats a number in compact notation for large values.
 * @param   {number} amount
 * @returns {string}  e.g. "1.84K"  |  "2.3M"  |  "847"
 */
export function formatAmountCompact(amount) {
  const num = parseFloat(amount);
  if (isNaN(num)) return "0";

  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000)     return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000)         return `${(num / 1_000).toFixed(2)}K`;
  return formatAmount(num);
}

/**
 * Formats a USD dollar amount.
 * @param   {number}  amount
 * @param   {object}  [opts]
 * @param   {boolean} [opts.compact=false]
 * @returns {string}  e.g. "$1,842.57"  |  "$1.84K"
 */
export function formatUSD(amount, { compact = false } = {}) {
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

/**
 * Converts a raw token bigint amount to a human-readable number string.
 * e.g. 1000000n with 6 decimals → "1.000000"
 *
 * @param   {bigint|string} rawAmount
 * @param   {number}        decimals
 * @param   {object}        [opts]
 * @param   {number}        [opts.displayDecimals=6]
 * @returns {string}
 */
export function formatTokenAmount(rawAmount, decimals, { displayDecimals = 6 } = {}) {
  if (!rawAmount) return "0";
  try {
    const human = parseFloat(formatUnits(BigInt(rawAmount), decimals));
    return formatAmount(human, { maxDecimals: displayDecimals });
  } catch {
    return "0";
  }
}

/**
 * Formats a liquidity value in compact notation.
 * Used in the vault status panel.
 * @param   {bigint|number} liquidity
 * @returns {string}  e.g. "1.23M"
 */
export function formatLiquidity(liquidity) {
  return formatAmountCompact(Number(liquidity));
}

// ─────────────────────────────────────────────────────────────────────────────
//  TIME FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a Unix timestamp (ms) as a relative "time ago" string.
 * Updates every second when used with a live timer.
 *
 * @param   {number} timestamp  — milliseconds since epoch
 * @returns {string}  e.g. "just now"  |  "2m ago"  |  "3h ago"  |  "2d ago"
 */
export function formatTimestamp(timestamp) {
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

/**
 * Formats a block number with locale separators.
 * @param   {number|bigint} blockNumber
 * @returns {string}  e.g. "12,345,678"
 */
export function formatBlockNumber(blockNumber) {
  if (!blockNumber) return "—";
  return Number(blockNumber).toLocaleString("en-US");
}

// ─────────────────────────────────────────────────────────────────────────────
//  POOL / TOKEN HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the display name for a pool from its token pair.
 * @param   {object} token0  — { symbol }
 * @param   {object} token1  — { symbol }
 * @returns {string}  e.g. "USDC / WETH"
 */
export function getPoolName(token0, token1) {
  if (!token0 || !token1) return "Unknown Pool";
  return `${token0.symbol} / ${token1.symbol}`;
}

/**
 * Returns a deterministic key for a pool — used as React list keys.
 * @param   {string} poolAddress
 * @returns {string}
 */
export function getPoolKey(poolAddress) {
  return poolAddress?.toLowerCase() ?? "unknown";
}

/**
 * Returns a human-readable fee tier label.
 * @param   {number} fee  — e.g. 500 | 3000 | 10000
 * @returns {string}  e.g. "0.05%"  |  "0.3%"  |  "1%"
 */
export function getFeeTierLabel(fee) {
  if (!fee) return "—";
  const pct = fee / 10_000;
  // Remove trailing zeros: 0.30 → 0.3, 1.00 → 1
  return `${pct.toFixed(2).replace(/\.?0+$/, "")}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  STRING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Truncates any string to a max length with ellipsis.
 * @param   {string} str
 * @param   {number} maxLength
 * @returns {string}
 */
export function truncateString(str, maxLength = 20) {
  if (!str || str.length <= maxLength) return str ?? "";
  return `${str.slice(0, maxLength)}...`;
}

/**
 * Copies a string to the clipboard.
 * Returns true on success, false on failure.
 * Used by address copy buttons throughout the UI.
 *
 * @param   {string} text
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
