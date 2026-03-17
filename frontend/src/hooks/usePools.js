// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — usePools.js
//  React hook that manages the full pool list.
//
//  Data flow:
//    1. On mount    → backend REST GET /api/pools  (initial load, always fresh)
//    2. On connect  → Socket.io "snapshot" event   (instant on reconnect)
//    3. Live        → Socket.io "price_update"     (tick + price per swap)
//    4. Live        → Socket.io "rebalanced"        (new rebalance event)
//    5. Live        → Socket.io "vault_created"    (new pool deployed)
//
//  Why both REST and socket snapshot?
//    REST gives us data even before the socket connects.
//    Socket snapshot ensures we're always up-to-date after a reconnect.
//    Both point to the same backend data — no inconsistency.
//
//  Returns:
//    {
//      pools:          Pool[]    — sorted by most recently rebalanced
//      isLoading:      boolean   — true during initial REST fetch
//      isConnected:    boolean   — Socket.io connection state
//      error:          string|null
//      refetch:        () => void — manually re-fetch from REST
//    }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from "react";
import socket from "@/lib/socket";

const API_BASE = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3001";

// ─────────────────────────────────────────────────────────────────────────────

export function usePools() {
  // poolAddress (lowercase) → Pool — Map gives O(1) updates
  const [poolMap, setPoolMap]       = useState(new Map());
  const [isLoading, setIsLoading]   = useState(true);
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [error, setError]           = useState(null);

  // Ref so socket handlers always see the latest poolMap without stale closure
  const poolMapRef = useRef(poolMap);
  poolMapRef.current = poolMap;

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Merges an array of pools into the map.
   * Existing entries are shallow-merged so live data is never overwritten
   * by a stale REST response.
   */
  const mergePools = useCallback((incoming) => {
    setPoolMap((prev) => {
      const next = new Map(prev);
      for (const pool of incoming) {
        const key      = pool.poolAddress?.toLowerCase();
        if (!key) continue;
        const existing = next.get(key) ?? {};
        next.set(key, _mergePool(existing, pool));
      }
      return next;
    });
  }, []);

  /**
   * Updates live data fields for a single pool.
   * Called on every "price_update" socket event.
   */
  const updateLiveData = useCallback((poolAddress, liveData) => {
    const key = poolAddress?.toLowerCase();
    if (!key) return;
    setPoolMap((prev) => {
      const existing = prev.get(key);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(key, {
        ...existing,
        liveData: { ...existing.liveData, ...liveData, lastUpdated: Date.now() },
      });
      return next;
    });
  }, []);

  /**
   * Prepends a rebalance event to the front of a pool's recentRebalances.
   * Keeps the last 10 entries.
   */
  const addRebalance = useCallback((poolAddress, event) => {
    const key = poolAddress?.toLowerCase();
    if (!key) return;
    setPoolMap((prev) => {
      const existing = prev.get(key);
      if (!existing) return prev;
      const next     = new Map(prev);
      const rebalances = [event, ...(existing.recentRebalances ?? [])].slice(0, 10);
      next.set(key, { ...existing, recentRebalances: rebalances });
      return next;
    });
  }, []);

  // ── Initial REST fetch ────────────────────────────────────────────────────

  const fetchPools = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res  = await fetch(`${API_BASE}/api/pools`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.success) mergePools(json.pools);
    } catch (err) {
      setError(`Failed to load pools: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [mergePools]);

  // ── Socket.io event listeners ─────────────────────────────────────────────

  useEffect(() => {
    // Initial REST fetch — runs once on mount
    fetchPools();

    // ── Connection state ────────────────────────────────────────────────────
    const onConnect    = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);

    // ── snapshot — full pool list sent on every (re)connect ────────────────
    // Replaces the entire map to ensure consistency after a reconnect.
    const onSnapshot = (pools) => {
      setPoolMap(() => {
        const next = new Map();
        for (const pool of pools) {
          const key = pool.poolAddress?.toLowerCase();
          if (key) next.set(key, pool);
        }
        return next;
      });
      setIsLoading(false);
      setError(null);
    };

    // ── price_update — fires on every swap ─────────────────────────────────
    // { poolAddress, currentTick, sqrtPriceX96, price, priceLabel }
    const onPriceUpdate = ({ poolAddress, ...liveData }) => {
      updateLiveData(poolAddress, liveData);
    };

    // ── rebalanced — fires when vault rebalances ────────────────────────────
    // { poolAddress, vaultAddress, newTick, oldTokenId, newTokenId,
    //   txHash, blockNumber, timestamp }
    const onRebalanced = ({ poolAddress, ...event }) => {
      // 1. Add to rebalance feed
      addRebalance(poolAddress, {
        newTick:     event.newTick,
        oldTokenId:  event.oldTokenId,
        newTokenId:  event.newTokenId,
        blockNumber: event.blockNumber,
        timestamp:   event.timestamp ?? Date.now(),
        txHash:      event.txHash,
      });

      // 2. Update tick range in liveData — the vault has moved its range
      //    The backend will send a full liveData refresh via polling shortly,
      //    but we optimistically update the tick display immediately.
      updateLiveData(poolAddress, {
        currentTick: event.newTick,
      });
    };

    // ── vault_created — new pool deployed via FluxFactory ──────────────────
    const onVaultCreated = (pool) => {
      mergePools([pool]);
    };

    // Register all listeners
    socket.on("connect",       onConnect);
    socket.on("disconnect",    onDisconnect);
    socket.on("snapshot",      onSnapshot);
    socket.on("price_update",  onPriceUpdate);
    socket.on("rebalanced",    onRebalanced);
    socket.on("vault_created", onVaultCreated);

    // Cleanup — remove every listener on unmount
    // Critical: without this, handlers stack up on every re-render
    return () => {
      socket.off("connect",       onConnect);
      socket.off("disconnect",    onDisconnect);
      socket.off("snapshot",      onSnapshot);
      socket.off("price_update",  onPriceUpdate);
      socket.off("rebalanced",    onRebalanced);
      socket.off("vault_created", onVaultCreated);
    };
  }, [fetchPools, mergePools, updateLiveData, addRebalance]);

  // ── Derived state — convert Map to sorted array ───────────────────────────

  const pools = _sortPools(Array.from(poolMap.values()));

  return {
    pools,
    isLoading,
    isConnected,
    error,
    refetch: fetchPools,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merges two pool objects.
 * Live data from `existing` is preserved if `incoming` has none —
 * prevents a stale REST response from wiping socket live data.
 */
function _mergePool(existing, incoming) {
  return {
    ...existing,
    ...incoming,
    // Keep the richer liveData — prefer incoming if it has a later lastUpdated
    liveData: _mergeLiveData(existing.liveData, incoming.liveData),
    // Merge rebalance history — deduplicate by txHash
    recentRebalances: _mergeRebalances(
      existing.recentRebalances,
      incoming.recentRebalances
    ),
  };
}

function _mergeLiveData(existing, incoming) {
  if (!existing) return incoming ?? {};
  if (!incoming) return existing;
  // Pick the more recently updated one
  if ((incoming.lastUpdated ?? 0) >= (existing.lastUpdated ?? 0)) {
    return { ...existing, ...incoming };
  }
  return existing;
}

function _mergeRebalances(existing = [], incoming = []) {
  const seen = new Set();
  const merged = [...incoming, ...existing].filter((r) => {
    const key = r.txHash ?? `${r.blockNumber}-${r.newTick}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return merged.slice(0, 10);
}

/**
 * Sorts pools for display on the pool list page.
 * Order: watching first, then by most recently rebalanced, then by createdAt.
 */
function _sortPools(pools) {
  return [...pools].sort((a, b) => {
    // Watching pools float to the top
    const aWatching = a.liveData?.watching ?? false;
    const bWatching = b.liveData?.watching ?? false;
    if (aWatching !== bWatching) return aWatching ? -1 : 1;

    // Then sort by most recently rebalanced
    const aLastRebalance = a.recentRebalances?.[0]?.timestamp ?? 0;
    const bLastRebalance = b.recentRebalances?.[0]?.timestamp ?? 0;
    if (aLastRebalance !== bLastRebalance) return bLastRebalance - aLastRebalance;

    // Finally by creation time (newest first)
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
}
