// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — priceUtils.js  (frontend)
//  All price and tick math used across the UI.
//
//  Functions exported:
//    sqrtPriceX96ToPrice()   — raw pool price from slot0
//    formatPrice()           — human readable price string
//    getPriceLabel()         — "1 WETH = $1,842.57" label
//    tickToPrice()           — convert a tick to a price
//    priceToTick()           — convert a price to the nearest tick
//    getTickRangePosition()  — 0–100 % position of tick within a range
//    getPriceImpact()        — estimate price impact of a swap amount
//    isStablecoin()          — true if address is a known USD stablecoin
//    isLowSTT()              — true if STT balance is dangerously low
//    formatSTT()             — "38.24 STT" from raw bigint
// ─────────────────────────────────────────────────────────────────────────────

import { formatUnits } from "viem";

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// Known stablecoin addresses on Somnia Testnet (lowercase)
const STABLECOINS = new Set([
  "0x28bec7e30e6faee657a03e19bf1128aad7632a00", // USDC
]);

// Uniswap V3 tick math constant: price = 1.0001^tick
const LOG_BASE = Math.log(1.0001);

// Minimum STT balance before showing a warning in the UI
const STT_WARNING_THRESHOLD = 5; // STT

// ─────────────────────────────────────────────────────────────────────────────
//  CORE PRICE MATH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a Uniswap V3 sqrtPriceX96 to a human-readable price.
 *
 * Returns "how much token0 per 1 token1" adjusted for decimals.
 * For a USDC(6) / WETH(18) pool this returns the USD price of 1 ETH.
 * e.g. sqrtPriceX96 → 1842.57
 *
 * @param   {bigint|string} sqrtPriceX96
 * @param   {number}        token0Decimals  — e.g. 6  for USDC
 * @param   {number}        token1Decimals  — e.g. 18 for WETH
 * @returns {number}
 */
export function sqrtPriceX96ToPrice(sqrtPriceX96, token0Decimals, token1Decimals) {
  const val = BigInt(sqrtPriceX96 ?? 0n);
  if (val === 0n) return 0;

  const Q96 = 2n ** 96n;

  // Compute as float. BigInt loses precision at Q96^2 scale so we scale down
  // by dividing both sides by 2^64 before multiplying — keeps us in float range.
  const sqrtPrice = Number(val) / Number(Q96);
  const priceRaw  = sqrtPrice * sqrtPrice;

  if (priceRaw === 0) return 0;

  // priceRaw = token1_raw / token0_raw
  // We want token0_human per 1 token1_human:
  //   price = (1 / priceRaw) * 10^(token1Decimals - token0Decimals)
  const decimalShift = Math.pow(10, token1Decimals - token0Decimals);
  return (1 / priceRaw) * decimalShift;
}

/**
 * Converts a Uniswap V3 tick to a price.
 * price = 1.0001^tick, adjusted for token decimals.
 *
 * @param   {number} tick
 * @param   {number} token0Decimals
 * @param   {number} token1Decimals
 * @returns {number}
 */
export function tickToPrice(tick, token0Decimals, token1Decimals) {
  // Raw price = 1.0001^tick (token1 per token0 in raw units)
  const rawPrice     = Math.pow(1.0001, tick);
  const decimalShift = Math.pow(10, token0Decimals - token1Decimals);
  // Invert to get token0 per token1
  return (1 / rawPrice) * decimalShift;
}

/**
 * Converts a human price back to the nearest valid Uniswap V3 tick.
 * Useful for displaying the price at tickLower and tickUpper.
 *
 * @param   {number} price          — token0 per token1 (human units)
 * @param   {number} token0Decimals
 * @param   {number} token1Decimals
 * @param   {number} tickSpacing    — round result to nearest multiple
 * @returns {number}
 */
export function priceToTick(price, token0Decimals, token1Decimals, tickSpacing = 1) {
  if (price <= 0) return 0;
  const decimalShift = Math.pow(10, token1Decimals - token0Decimals);
  // Invert: rawPrice = token1_raw / token0_raw = 1 / (price * decimalShift)
  const rawPrice = 1 / (price * decimalShift);
  const tick     = Math.log(rawPrice) / LOG_BASE;
  // Round to nearest tick spacing
  return Math.round(tick / tickSpacing) * tickSpacing;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TICK RANGE POSITION
//  Used by TickRangeBar to place the current-tick dot on the visual bar.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the current tick's position within the LP range as a 0–100 percentage.
 * Values outside [0, 100] mean the tick is out of range.
 *
 * @param   {number} currentTick
 * @param   {number} tickLower
 * @param   {number} tickUpper
 * @returns {number}  0 = at lower bound, 100 = at upper bound
 */
export function getTickRangePosition(currentTick, tickLower, tickUpper) {
  if (tickUpper === tickLower) return 50; // degenerate range guard
  return ((currentTick - tickLower) / (tickUpper - tickLower)) * 100;
}

/**
 * Classifies the tick's position for UI colour coding.
 *
 * @param   {number} position  — result of getTickRangePosition()
 * @returns {"in-range"|"near-edge"|"out-of-range"}
 */
export function getTickRangeStatus(position) {
  if (position < 0 || position >= 100) return "out-of-range";
  if (position < 10 || position > 90)  return "near-edge";
  return "in-range";
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRICE FORMATTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a raw price number into a human-readable string.
 * Adapts decimal places to the magnitude of the price.
 *
 * @param   {number}  price
 * @param   {object}  [opts]
 * @param   {boolean} [opts.compact=false]  — use compact notation for large numbers
 * @returns {string}  e.g. "1,842.57"  |  "0.000482"  |  "1.84K"
 */
export function formatPrice(price, { compact = false } = {}) {
  if (!price || isNaN(price) || !isFinite(price)) return "—";

  if (compact && price >= 1_000_000) {
    return (price / 1_000_000).toFixed(2) + "M";
  }
  if (compact && price >= 1_000) {
    return (price / 1_000).toFixed(2) + "K";
  }

  // Adapt decimal places to magnitude
  if (price >= 1000)  return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1)     return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (price >= 0.001) return price.toFixed(6);
  return price.toExponential(4);
}

/**
 * Builds the main price label shown on pool cards and the swap page.
 * Accounts for stablecoin pairing to show USD value.
 *
 * @param   {number} price
 * @param   {object} token0  — { symbol, address }
 * @param   {object} token1  — { symbol, address }
 * @returns {string}  e.g. "1 WETH = $1,842.57"  or  "1 TOKEN_A = 0.05 TOKEN_B"
 */
export function getPriceLabel(price, token0, token1) {
  if (!price || !token0 || !token1) return "—";

  const formatted = formatPrice(price);

  // token0 is stablecoin → price = USD value of 1 token1
  if (isStablecoin(token0.address, token0.symbol)) {
    return `1 ${token1.symbol} = $${formatted}`;
  }

  // token1 is stablecoin → invert to get USD value of 1 token0
  if (isStablecoin(token1.address, token1.symbol)) {
    const inverted = price > 0 ? 1 / price : 0;
    return `1 ${token0.symbol} = $${formatPrice(inverted)}`;
  }

  // Neither is stablecoin — show plain ratio, no dollar sign
  return `1 ${token1.symbol} = ${formatted} ${token0.symbol}`;
}

/**
 * Formats the price at a specific tick for range boundary labels.
 * e.g. shown at tickLower and tickUpper ends of the range bar.
 *
 * @param   {number} tick
 * @param   {object} token0  — { symbol, address, decimals }
 * @param   {object} token1  — { symbol, address, decimals }
 * @returns {string}
 */
export function getTickPriceLabel(tick, token0, token1) {
  const price = tickToPrice(tick, token0.decimals, token1.decimals);
  if (isStablecoin(token0.address) || isStablecoin(token0.symbol)) {
    return `$${formatPrice(price)}`;
  }
  return formatPrice(price);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRICE IMPACT
//  Rough estimate shown on the swap UI. Not exact — uses the constant product
//  approximation. Good enough for display purposes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimates price impact of a swap as a percentage.
 * Uses the x*y=k approximation — acceptable for small amounts.
 *
 * @param   {number} amountIn       — human units (e.g. 1000 for 1000 USDC)
 * @param   {number} reserveIn      — approximate reserve of input token
 * @param   {number} feePct         — pool fee as fraction (e.g. 0.003 for 0.3%)
 * @returns {number}                — e.g. 0.12 means 0.12% impact
 */
export function getPriceImpact(amountIn, reserveIn, feePct = 0.003) {
  if (!amountIn || !reserveIn || reserveIn === 0) return 0;
  const amountInWithFee = amountIn * (1 - feePct);
  return (amountInWithFee / (reserveIn + amountInWithFee)) * 100;
}

/**
 * Returns a colour class for price impact severity.
 * Used to colour the price impact label on the swap box.
 *
 * @param   {number} impactPct
 * @returns {"text-secondary"|"text-yellow"|"text-red"}
 */
export function getPriceImpactColor(impactPct) {
  if (impactPct >= 5) return "text-red";
  if (impactPct >= 1) return "text-yellow";
  return "text-secondary";
}

/**
 * Formats price impact for display.
 * @param   {number} impactPct
 * @returns {string}  e.g. "<0.01%"  |  "0.12%"  |  "3.45%"
 */
export function formatPriceImpact(impactPct) {
  if (impactPct < 0.01) return "<0.01%";
  return `${impactPct.toFixed(2)}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOKEN HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the token address is a known USD stablecoin.
 * Used to determine whether the pool price = USD price.
 *
 * @param   {string} address
 * @returns {boolean}
 */
export function isStablecoin(address, symbol) {
  if (symbol && STABLECOIN_SYMBOLS.has(symbol.toUpperCase())) return true;
  if (address && STABLECOIN_ADDRESSES.has(address.toLowerCase())) return true;
  return false;
}

/**
 * Formats a fee tier number into a readable string.
 * @param   {number} fee  — e.g. 3000
 * @returns {string}      — e.g. "0.3%"
 */
export function formatFeeTier(fee) {
  if (!fee) return "—";
  return `${(fee / 10000).toFixed(2).replace(/\.?0+$/, "")}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  STT BALANCE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a raw STT balance (bigint wei) to a readable string.
 * @param   {bigint|string} rawBalance  — wei value
 * @returns {string}                    — e.g. "38.24 STT"
 */
export function formatSTT(rawBalance) {
  if (!rawBalance) return "0 STT";
  const formatted = parseFloat(formatUnits(BigInt(rawBalance), 18));
  return `${formatted.toFixed(2)} STT`;
}

/**
 * Returns true if the STT balance is below the warning threshold.
 * Used to show a yellow warning badge on the vault status panel.
 *
 * @param   {string|number} sttBalance  — formatted STT value (e.g. "38.24")
 * @returns {boolean}
 */
export function isLowSTT(sttBalance) {
  return parseFloat(sttBalance) < STT_WARNING_THRESHOLD;
}

/**
 * Returns true if the STT balance is below the minimum required (32 STT).
 * Used to show an error state — vault subscriptions will stop working.
 *
 * @param   {string|number} sttBalance
 * @returns {boolean}
 */
export function isCriticalSTT(sttBalance) {
  return parseFloat(sttBalance) < 32;
}
