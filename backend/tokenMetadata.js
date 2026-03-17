// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — tokenMetadata.js
//  Resolves token symbol, name, decimals, and logo URI for any ERC-20 address.
//
//  Resolution order:
//    1. In-memory cache (instant)
//    2. Uniswap Token List (free, no API key, covers USDC/WETH/major tokens)
//    3. On-chain ERC-20 calls for symbol/name/decimals (fallback for unknown tokens)
//    4. Generated identicon URL for logo (last resort — always works)
// ─────────────────────────────────────────────────────────────────────────────

import { getContract } from "viem";
import { httpClient }  from "./chain.js";
import { ERC20_ABI }   from "./abis.js";

// ── Uniswap Token List URL ────────────────────────────────────────────────────
const UNISWAP_TOKEN_LIST_URL = "https://tokens.uniswap.org";

// ── In-memory stores ──────────────────────────────────────────────────────────

// address (lowercase) → TokenMetadata
const metadataCache = new Map();

// address (lowercase) → entry from Uniswap token list
let uniswapListByAddress = new Map();
let uniswapListLoaded    = false;

// ── Types (JSDoc) ─────────────────────────────────────────────────────────────
/**
 * @typedef {Object} TokenMetadata
 * @property {string} address   — checksummed address
 * @property {string} symbol    — e.g. "USDC"
 * @property {string} name      — e.g. "USD Coin"
 * @property {number} decimals  — e.g. 6
 * @property {string} logoURI   — URL to token logo image
 */

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads the Uniswap Token List into memory.
 * Call once at startup. Safe to call multiple times (idempotent).
 */
export async function loadUniswapTokenList() {
  if (uniswapListLoaded) return;

  try {
    const res  = await fetch(UNISWAP_TOKEN_LIST_URL);
    const json = await res.json();

    for (const token of json.tokens) {
      uniswapListByAddress.set(token.address.toLowerCase(), token);
    }

    console.log(`[TokenMetadata] Uniswap token list loaded: ${uniswapListByAddress.size} tokens`);
    uniswapListLoaded = true;
  } catch (err) {
    // Non-fatal — we fall back to on-chain reads
    console.warn("[TokenMetadata] Failed to load Uniswap token list:", err.message);
    uniswapListLoaded = true; // mark as loaded so we don't retry endlessly
  }
}

/**
 * Returns metadata for a token address.
 * Resolves from cache → Uniswap list → on-chain → generated fallback.
 *
 * @param   {string} address  — token contract address (any case)
 * @returns {Promise<TokenMetadata>}
 */
export async function getTokenMetadata(address) {
  const key = address.toLowerCase();

  // 1. Cache hit
  if (metadataCache.has(key)) return metadataCache.get(key);

  let metadata;

  // 2. Uniswap Token List
  const listEntry = uniswapListByAddress.get(key);
  if (listEntry) {
    metadata = {
      address:  address,
      symbol:   listEntry.symbol,
      name:     listEntry.name,
      decimals: listEntry.decimals,
      logoURI:  listEntry.logoURI ?? _identiconUrl(address),
    };
  } else {
    // 3. On-chain fallback — ERC-20 symbol/name/decimals calls
    metadata = await _fetchFromChain(address);
  }

  metadataCache.set(key, metadata);
  return metadata;
}

/**
 * Resolves metadata for both tokens in a pool pair.
 * Batches the two lookups in parallel.
 *
 * @param   {string} token0Address
 * @param   {string} token1Address
 * @returns {Promise<[TokenMetadata, TokenMetadata]>}
 */
export async function getPoolTokenMetadata(token0Address, token1Address) {
  return Promise.all([
    getTokenMetadata(token0Address),
    getTokenMetadata(token1Address),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRICE MATH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a Uniswap V3 sqrtPriceX96 to a human-readable price.
 * Returns how much token0 you get per 1 token1 (adjusted for decimals).
 *
 * For a USDC(6)/WETH(18) pool this returns the USD price of 1 ETH.
 * e.g. sqrtPriceX96 → 1842.57 (meaning 1 WETH = 1842.57 USDC = $1842.57)
 *
 * @param   {bigint} sqrtPriceX96
 * @param   {number} token0Decimals
 * @param   {number} token1Decimals
 * @returns {number}
 */
export function sqrtPriceX96ToPrice(sqrtPriceX96, token0Decimals, token1Decimals) {
  if (sqrtPriceX96 === 0n) return 0;

  const Q96 = 2n ** 96n;

  // price_raw = (sqrtPriceX96 / 2^96)^2 = token1 per token0 in raw units
  // We compute as float — BigInt loses precision at large values so we scale down
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const priceRaw  = sqrtPrice * sqrtPrice;

  // Adjust for decimal difference
  // priceRaw is token1_raw_units / token0_raw_units
  // to get token0_human / token1_human:
  //   price = (1 / priceRaw) * 10^(token1Decimals - token0Decimals)
  const decimalAdjustment = Math.pow(10, token1Decimals - token0Decimals);
  const price = (1 / priceRaw) * decimalAdjustment;

  return price;
}

/**
 * Determines if a token address is a known USD stablecoin.
 * If one token in a pair is a stablecoin, the pool price = USD price.
 *
 * @param   {string} address
 * @returns {boolean}
 */
export function isStablecoin(address) {
  // Known stablecoin addresses — extend as needed
  const stablecoins = new Set([
    "0x28bec7e30e6faee657a03e19bf1128aad7632a00", // USDC on Somnia testnet
  ]);
  return stablecoins.has(address.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL
// ─────────────────────────────────────────────────────────────────────────────

async function _fetchFromChain(address) {
  try {
    const contract = getContract({
      address: address,
      abi:     ERC20_ABI,
      client:  httpClient,
    });

    const [symbol, name, decimals] = await Promise.all([
      contract.read.symbol(),
      contract.read.name(),
      contract.read.decimals(),
    ]);

    return {
      address:  address,
      symbol:   symbol,
      name:     name,
      decimals: Number(decimals),
      logoURI:  _identiconUrl(address),
    };
  } catch (err) {
    console.warn(`[TokenMetadata] On-chain fetch failed for ${address}:`, err.message);
    // Absolute fallback
    return {
      address:  address,
      symbol:   address.slice(0, 6) + "...",
      name:     "Unknown Token",
      decimals: 18,
      logoURI:  _identiconUrl(address),
    };
  }
}

/**
 * Generates a deterministic identicon URL for any address.
 * Uses the DiceBear API — free, no key, always returns an image.
 */
function _identiconUrl(address) {
  return `https://api.dicebear.com/7.x/identicon/svg?seed=${address.toLowerCase()}`;
}
