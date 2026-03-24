// src/hooks/usePool.ts
import { useState, useEffect, useCallback, useRef } from "react";
import socket from "../lib/socket.ts";
import { readVaultFull } from "../lib/chain.ts";
import { sqrtPriceX96ToPrice, getPriceLabel } from "../lib/priceUtils.ts";
import type { Pool, LiveData, RebalanceEvent } from "../types"

const API_BASE = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3001";

export function usePool(poolAddress: string | undefined) {
  const [pool, setPool] = useState<Pool | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isConnected, setIsConnected] = useState<boolean>(socket.connected);
  const [error, setError] = useState<string | null>(null);
  const [lastRebalance, setLastRebalance] = useState<RebalanceEvent | null>(null);

  const poolKey = poolAddress?.toLowerCase();
  const poolRef = useRef<Pool | null>(pool);
  poolRef.current = pool;

  const mergePool = useCallback((incoming: Partial<Pool>) => {
    setPool((prev) => {
      if (!prev && !incoming) return null;
      if (!prev) return incoming as Pool;
      return {
        ...prev,
        ...incoming,
        liveData: _mergeLiveData(prev.liveData, incoming.liveData),
        recentRebalances: _mergeRebalances(prev.recentRebalances, incoming.recentRebalances),
      };
    });
  }, []);

  const patchLiveData = useCallback((patch: Partial<LiveData>) => {
    setPool((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        liveData: { ...prev.liveData, ...patch, lastUpdated: Date.now() },
      };
    });
  }, []);

  const applyRebalance = useCallback((event: RebalanceEvent) => {
    setPool((prev) => {
      if (!prev) return null;
      const rebalances = [event, ...(prev.recentRebalances ?? [])].slice(0, 10);
      return {
        ...prev,
        recentRebalances: rebalances,
        liveData: {
          ...prev.liveData,
          currentTick: event.newTick,
          lastUpdated: Date.now(),
        },
      };
    });
    setLastRebalance(event);
  }, []);

  const fetchPool = useCallback(async () => {
    if (!poolKey) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/pools/${poolKey}`);
      if (res.status === 404) throw new Error("Pool not found");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.success) mergePool(json.pool);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, [poolKey, mergePool]);

  const refreshFromChain = useCallback(async () => {
    const current = poolRef.current;
    if (!current?.vaultAddress || !current?.poolAddress) return;

    try {
      const { config, slot0 } = await readVaultFull(current.vaultAddress, current.poolAddress);
      const price = sqrtPriceX96ToPrice(
        slot0.sqrtPriceX96.toString(),
        current.token0.decimals,
        current.token1.decimals
      );
      const priceLabel = getPriceLabel(price, current.token0, current.token1);

      patchLiveData({
        sqrtPriceX96: slot0.sqrtPriceX96.toString(),
        currentTick: slot0.tick,
        price,
        priceLabel,
        tickLower: config.tickLower,
        tickUpper: config.tickUpper,
        watching: config.watching,
        initialized: config.initialized,
      });
    } catch (err: any) {
      console.warn("[usePool] refreshFromChain failed:", err.message);
    }
  }, [patchLiveData]);

  useEffect(() => {
    if (!poolKey) return;
    fetchPool();

    const onConnect = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);
    
    const onSnapshot = (pools: Pool[]) => {
      const match = pools.find((p) => p.poolAddress?.toLowerCase() === poolKey);
      if (match) mergePool(match);
      setIsLoading(false);
    };

    const onPriceUpdate = ({ poolAddress, ...liveData }: LiveData & { poolAddress: string }) => {
      if (poolAddress?.toLowerCase() !== poolKey) return;
      patchLiveData(liveData);
    };

    const onRebalanced = (event: RebalanceEvent) => {
      if (event.poolAddress?.toLowerCase() !== poolKey) return;
      applyRebalance({ ...event, timestamp: event.timestamp ?? Date.now() });
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("snapshot", onSnapshot);
    socket.on("price_update", onPriceUpdate);
    socket.on("rebalanced", onRebalanced);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("snapshot", onSnapshot);
      socket.off("price_update", onPriceUpdate);
      socket.off("rebalanced", onRebalanced);
    };
  }, [poolKey, fetchPool, mergePool, patchLiveData, applyRebalance]);

  return { pool, isLoading, isConnected, error, lastRebalance, refetch: fetchPool, refreshFromChain };
}

// Internal Helpers
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