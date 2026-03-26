// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — api.js
//  Express REST API.
//
//  Endpoints:
//    GET /pools              — list all indexed pools with live data
//    GET /pools/:poolAddress — single pool by address
//    GET /pools/:poolAddress/rebalances — rebalance history for a pool
//    GET /health             — uptime check
// ─────────────────────────────────────────────────────────────────────────────

import { Router }        from "express";
import { getAllPools, getPoolByAddress } from "./store.js";

export const router = Router();

// ── GET /pools ────────────────────────────────────────────────────────────────
// Returns all indexed pools with full token metadata and live chain data.
router.get("/pools", (_req, res) => {
  const pools = getAllPools().map(_serializePool);
  res.json({ success: true, count: pools.length, pools });
});

// ── GET /pools/:poolAddress ───────────────────────────────────────────────────
// Returns a single pool by its pool contract address.
router.get("/pools/:poolAddress", (req, res) => {
  const pool = getPoolByAddress(req.params.poolAddress);
  if (!pool) {
    return res.status(404).json({
      success: false,
      error:   "Pool not found",
    });
  }
  res.json({ success: true, pool: _serializePool(pool) });
});

// ── GET /pools/:poolAddress/rebalances ────────────────────────────────────────
// Returns the last 10 Rebalanced events for a pool.
router.get("/pools/:poolAddress/rebalances", (req, res) => {
  const pool = getPoolByAddress(req.params.poolAddress);
  if (!pool) {
    return res.status(404).json({ success: false, error: "Pool not found" });
  }
  res.json({
    success:    true,
    poolAddress: pool.poolAddress,
    rebalances: pool.recentRebalances ?? [],
  });
});

// ── GET /health ───────────────────────────────────────────────────────────────
router.get("/health", (_req, res) => {
  res.json({
    success:    true,
    status:     "ok",
    poolsIndexed: getAllPools().length,
    uptime:     process.uptime(),
    timestamp:  Date.now(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  SERIALIZER
//  Converts internal store entry to a clean API response shape.
//  BigInts are serialized to strings to avoid JSON serialization errors.
// ─────────────────────────────────────────────────────────────────────────────

function _serializePool(pool) {
  return {
    poolAddress:   pool.poolAddress,
    vaultAddress:  pool.vaultAddress,
    fee:           pool.fee,
    feePct:        pool.fee ? `${pool.fee / 10000}%` : null,
    deployer:      pool.deployer,
    createdAt:     pool.createdAt,

    token0: pool.token0 ? {
      address:  pool.token0.address,
      symbol:   pool.token0.symbol,
      name:     pool.token0.name,
      decimals: pool.token0.decimals,
      logoURI:  pool.token0.logoURI,
    } : null,

    token1: pool.token1 ? {
      address:  pool.token1.address,
      symbol:   pool.token1.symbol,
      name:     pool.token1.name,
      decimals: pool.token1.decimals,
      logoURI:  pool.token1.logoURI,
    } : null,

    liveData: pool.liveData ? {
      currentTick:   pool.liveData.currentTick,
      sqrtPriceX96:  pool.liveData.sqrtPriceX96?.toString(),
      price:         pool.liveData.price,
      priceLabel:    pool.liveData.priceLabel,
      tickLower:     pool.liveData.tickLower,
      tickUpper:     pool.liveData.tickUpper,
      halfWidth:     pool.liveData.halfWidth,
      watching:      pool.liveData.watching,
      initialized:   pool.liveData.initialized,
      sttBalance:    pool.liveData.sttBalance,
      poolBalance0:  pool.liveData.poolBalance0 ?? null,
      poolBalance1:  pool.liveData.poolBalance1 ?? null,
      lastUpdated:   pool.liveData.lastUpdated,
    } : null,

    lastRebalanceFailure: pool.lastRebalanceFailure ? {
      newTick:     pool.lastRebalanceFailure.newTick,
      oldTokenId:  pool.lastRebalanceFailure.oldTokenId,
      reason:      pool.lastRebalanceFailure.reason,
      blockNumber: pool.lastRebalanceFailure.blockNumber,
      timestamp:   pool.lastRebalanceFailure.timestamp,
      txHash:      pool.lastRebalanceFailure.txHash,
      timeAgo:     _timeAgo(pool.lastRebalanceFailure.timestamp),
    } : null,

    recentRebalances: (pool.recentRebalances ?? []).map(r => ({
      newTick:     r.newTick,
      oldTokenId:  r.oldTokenId,
      newTokenId:  r.newTokenId,
      blockNumber: r.blockNumber,
      timestamp:   r.timestamp,
      txHash:      r.txHash,
      timeAgo:     _timeAgo(r.timestamp),
    })),
  };
}

function _timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60)  return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
