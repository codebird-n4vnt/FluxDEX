// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — usePool.js
//  React hook for a single pool — used on the Swap page (/swap/:poolAddress).
//
//  Data flow:
//    1. On mount    → REST GET /api/pools/:poolAddress  (always-fresh initial load)
//    2. On connect  → Socket.io "snapshot" — find this pool in the array
//    3. Live        → Socket.io "price_update" filtered to this poolAddress
//    4. Live        → Socket.io "rebalanced"  filtered to this poolAddress
//
//  Also exposes:
//    refetch()           — manual refresh from REST
//    refreshFromChain()  — direct on-chain read via viem (post-swap confirmation)
//
//  Returns:
//    {
//      pool:              Pool | null
//      isLoading:         boolean
//      isConnected:       boolean
//      error:             string | null
//      lastRebalance:     RebalanceEvent | null   ← most recent, for toast trigger
//      refetch:           () => void
//      refreshFromChain:  () => Promise<void>
//    }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from "react";
import socket                                        from "@/lib/socket";
import { readVaultFull }                             from "@/lib/chain";
import { sqrtPriceX96ToPrice, getPriceLabel }        from "@/lib/priceUtils";

const API_BASE = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3001";

// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} poolAddress  — the pool contract address from the URL param
 */
export function usePool(poolAddress) {
  const [pool, setPool]             = useState(null);
  const [isLoading, setIsLoading]   = useState(true);
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [error, setError]           = useState(null);

  // Tracks the most recent rebalance event separately so the swap page
  // can watch it with a useEffect and trigger a toast notification.
  const [lastRebalance, setLastRebalance] = useState(null);

  // Normalised key for all comparisons — never trust casing from URL params
  const poolKey = poolAddress?.toLowerCase();

  // Ref so socket handlers always close over latest pool without re-registering
  const poolRef = useRef(pool);
  poolRef.current = pool;

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Merges partial incoming data into the current pool state.
   * Existing fields are preserved if incoming doesn't have them.
   */
  const mergePool = useCallback((incoming) => {
    setPool((prev) => {
      if (!prev && !incoming) return null;
      if (!prev) return incoming;
      return {
        ...prev,
        ...incoming,
        liveData: _mergeLiveData(prev.liveData, incoming?.liveData),
        recentRebalances: _mergeRebalances(
          prev.recentRebalances,
          incoming?.recentRebalances
        ),
      };
    });
  }, []);

  /**
   * Patches only the liveData field — used on price_update events.
   */
  const patchLiveData = useCallback((patch) => {
    setPool((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        liveData: {
          ...prev.liveData,
          ...patch,
          lastUpdated: Date.now(),
        },
      };
    });
  }, []);

  /**
   * Prepends a rebalance event and updates the tick display immediately.
   */
  const applyRebalance = useCallback((event) => {
    setPool((prev) => {
      if (!prev) return null;
      const rebalances = [event, ...(prev.recentRebalances ?? [])].slice(0, 10);
      return {
        ...prev,
        recentRebalances: rebalances,
        liveData: {
          ...prev.liveData,
          // Optimistic tick update — backend confirms via next poll
          currentTick:  event.newTick,
          lastUpdated:  Date.now(),
        },
      };
    });

    // Expose as lastRebalance so the swap page can trigger a toast
    setLastRebalance(event);
  }, []);

  // ── Initial REST fetch ────────────────────────────────────────────────────

  const fetchPool = useCallback(async () => {
    if (!poolKey) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/pools/${poolKey}`);
      if (res.status === 404) throw new Error("Pool not found");
      if (!res.ok)            throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.success) mergePool(json.pool);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, [poolKey, mergePool]);

  // ── Direct chain read — called after user submits a swap ─────────────────
  // Bypasses the backend entirely and reads vault.config() + pool.slot0()
  // directly from the chain so the UI reflects the swap immediately.

  const refreshFromChain = useCallback(async () => {
    const current = poolRef.current;
    if (!current?.vaultAddress || !current?.poolAddress) return;

    try {
      const { config, slot0 } = await readVaultFull(
        current.vaultAddress,
        current.poolAddress
      );

      const price = sqrtPriceX96ToPrice(
        slot0.sqrtPriceX96,
        current.token0?.decimals ?? 18,
        current.token1?.decimals ?? 18
      );

      const priceLabel = getPriceLabel(
        price,
        current.token0,
        current.token1
      );

      patchLiveData({
        sqrtPriceX96: slot0.sqrtPriceX96.toString(),
        currentTick:  slot0.tick,
        price,
        priceLabel,
        tickLower:    config.tickLower,
        tickUpper:    config.tickUpper,
        watching:     config.watching,
        initialized:  config.initialized,
      });
    } catch (err) {
      // Non-fatal — backend polling will catch up within POLL_INTERVAL_MS
      console.warn("[usePool] refreshFromChain failed:", err.message);
    }
  }, [patchLiveData]);

  // ── Socket.io event listeners ─────────────────────────────────────────────

  useEffect(() => {
    if (!poolKey) return;

    // Initial REST fetch
    fetchPool();

    // ── Connection state ────────────────────────────────────────────────────
    const onConnect    = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);

    // ── snapshot — find this pool in the full list ──────────────────────────
    const onSnapshot = (pools) => {
      const match = pools.find(
        (p) => p.poolAddress?.toLowerCase() === poolKey
      );
      if (match) mergePool(match);
      setIsLoading(false);
    };

    // ── price_update — filter to this pool only ─────────────────────────────
    // { poolAddress, currentTick, sqrtPriceX96, price, priceLabel }
    const onPriceUpdate = ({ poolAddress, ...liveData }) => {
      if (poolAddress?.toLowerCase() !== poolKey) return;
      patchLiveData(liveData);
    };

    // ── rebalanced — filter to this pool only ───────────────────────────────
    // { poolAddress, vaultAddress, newTick, oldTokenId, newTokenId,
    //   txHash, blockNumber, timestamp }
    const onRebalanced = (event) => {
      if (event.poolAddress?.toLowerCase() !== poolKey) return;
      applyRebalance({
        newTick:     event.newTick,
        oldTokenId:  event.oldTokenId,
        newTokenId:  event.newTokenId,
        blockNumber: event.blockNumber,
        timestamp:   event.timestamp ?? Date.now(),
        txHash:      event.txHash,
      });
    };

    // Register listeners
    socket.on("connect",      onConnect);
    socket.on("disconnect",   onDisconnect);
    socket.on("snapshot",     onSnapshot);
    socket.on("price_update", onPriceUpdate);
    socket.on("rebalanced",   onRebalanced);

    return () => {
      socket.off("connect",      onConnect);
      socket.off("disconnect",   onDisconnect);
      socket.off("snapshot",     onSnapshot);
      socket.off("price_update", onPriceUpdate);
      socket.off("rebalanced",   onRebalanced);
    };
  }, [poolKey, fetchPool, mergePool, patchLiveData, applyRebalance]);

  return {
    pool,
    isLoading,
    isConnected,
    error,
    lastRebalance,    // watch this in Swap.jsx to trigger toast
    refetch:          fetchPool,
    refreshFromChain, // call after swap tx confirms
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _mergeLiveData(existing, incoming) {
  if (!existing) return incoming ?? {};
  if (!incoming) return existing;
  if ((incoming.lastUpdated ?? 0) >= (existing.lastUpdated ?? 0)) {
    return { ...existing, ...incoming };
  }
  return existing;
}

function _mergeRebalances(existing = [], incoming = []) {
  const seen   = new Set();
  const merged = [...incoming, ...existing].filter((r) => {
    const key = r.txHash ?? `${r.blockNumber}-${r.newTick}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return merged.slice(0, 10);
}
