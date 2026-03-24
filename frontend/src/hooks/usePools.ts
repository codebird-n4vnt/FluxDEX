// src/hooks/usePools.ts
import { useState, useEffect, useCallback, useRef } from "react";
import socket from "../lib/socket";
import type { Pool, LiveData, RebalanceEvent } from "../types";

const API_BASE = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3001";

export function usePools() {
  const [poolMap, setPoolMap] = useState<Map<string, Pool>>(new Map());
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isConnected, setIsConnected] = useState<boolean>(socket.connected);
  const [error, setError] = useState<string | null>(null);

  const poolMapRef = useRef(poolMap);
  poolMapRef.current = poolMap;

  const mergePools = useCallback((incoming: Pool[]) => {
    setPoolMap((prev) => {
      const next = new Map(prev);
      for (const pool of incoming) {
        const key = pool.poolAddress?.toLowerCase();
        if (!key) continue;
        const existing = next.get(key) ?? ({} as Pool);
        next.set(key, _mergePool(existing, pool));
      }
      return next;
    });
  }, []);

  const updateLiveData = useCallback((poolAddress: string, liveData: Partial<LiveData>) => {
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

  const addRebalance = useCallback((poolAddress: string, event: RebalanceEvent) => {
    const key = poolAddress?.toLowerCase();
    if (!key) return;
    setPoolMap((prev) => {
      const existing = prev.get(key);
      if (!existing) return prev;
      const next = new Map(prev);
      const rebalances = [event, ...(existing.recentRebalances ?? [])].slice(0, 10);
      next.set(key, { ...existing, recentRebalances: rebalances });
      return next;
    });
  }, []);

  const fetchPools = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/pools`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.success) mergePools(json.pools);
    } catch (err: any) {
      setError(`Failed to load pools: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [mergePools]);

  useEffect(() => {
    fetchPools();

    const onConnect = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);

    const onSnapshot = (pools: Pool[]) => {
      setPoolMap(() => {
        const next = new Map<string, Pool>();
        for (const pool of pools) {
          const key = pool.poolAddress?.toLowerCase();
          if (key) next.set(key, pool);
        }
        return next;
      });
      setIsLoading(false);
      setError(null);
    };

    const onPriceUpdate = ({ poolAddress, ...liveData }: LiveData & { poolAddress: string }) => {
      updateLiveData(poolAddress, liveData);
    };

    const onRebalanced = ({ poolAddress, ...event }: RebalanceEvent & { poolAddress: string }) => {
      addRebalance(poolAddress, { ...event, timestamp: event.timestamp ?? Date.now() });
      updateLiveData(poolAddress, { currentTick: event.newTick });
    };

    const onVaultCreated = (pool: Pool) => {
      mergePools([pool]);
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("snapshot", onSnapshot);
    socket.on("price_update", onPriceUpdate);
    socket.on("rebalanced", onRebalanced);
    socket.on("vault_created", onVaultCreated);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("snapshot", onSnapshot);
      socket.off("price_update", onPriceUpdate);
      socket.off("rebalanced", onRebalanced);
      socket.off("vault_created", onVaultCreated);
    };
  }, [fetchPools, mergePools, updateLiveData, addRebalance]);

  const pools = _sortPools(Array.from(poolMap.values()));

  return { pools, isLoading, isConnected, error, refetch: fetchPools };
}

function _mergePool(existing: Pool, incoming: Pool): Pool {
  return {
    ...existing,
    ...incoming,
    liveData: _mergeLiveData(existing.liveData, incoming.liveData),
    recentRebalances: _mergeRebalances(existing.recentRebalances, incoming.recentRebalances),
  };
}

function _mergeLiveData(existing?: LiveData, incoming?: LiveData): LiveData {
  if (!existing) return incoming ?? {};
  if (!incoming) return existing;
  if ((incoming.lastUpdated ?? 0) >= (existing.lastUpdated ?? 0)) {
    return { ...existing, ...incoming };
  }
  return existing;
}

function _mergeRebalances(existing: RebalanceEvent[] = [], incoming: RebalanceEvent[] = []): RebalanceEvent[] {
  const seen = new Set<string>();
  const merged = [...incoming, ...existing].filter((r) => {
    const key = r.txHash ?? `${r.blockNumber}-${r.newTick}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return merged.slice(0, 10);
}

function _sortPools(pools: Pool[]): Pool[] {
  return [...pools].sort((a, b) => {
    const aWatching = a.liveData?.watching ?? false;
    const bWatching = b.liveData?.watching ?? false;
    if (aWatching !== bWatching) return aWatching ? -1 : 1;

    const aLastRebalance = a.recentRebalances?.[0]?.timestamp ?? 0;
    const bLastRebalance = b.recentRebalances?.[0]?.timestamp ?? 0;
    if (aLastRebalance !== bLastRebalance) return bLastRebalance - aLastRebalance;

    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
}