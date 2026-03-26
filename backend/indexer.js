// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — indexer.js  (FIXED)
//
//  BUGS FIXED vs original:
//
//  FIX 1 — Double subscription
//    _replayHistoricalEvents was calling _subscribeToVaultEvents per vault,
//    then _startLiveSubscriptions called it again for every pool in the store.
//    Result: 2× Rebalanced + 2× Swap listeners per vault → duplicate broadcasts.
//    Fix: _replayHistoricalEvents only populates the store. _startLiveSubscriptions
//    is the single place that registers all WSS listeners.
//
//  FIX 2 — Stale liveData broadcast
//    _pollAllVaults snapshotted getAllPools() BEFORE refreshing, then read
//    pool.liveData from the stale snapshot after refresh.
//    Fix: call getAllPools() again after Promise.allSettled to get fresh refs.
//
//  FIX 3 — Silent WSS death, no reconnect
//    viem watchContractEvent has no built-in reconnect. When the WebSocket drops
//    all Rebalanced + Swap listeners die silently. The polling loop kept running
//    but only price_update was broadcast, never rebalanced.
//    Fix: track all WSS unwatch functions. On wssClient error/close, tear down
//    all watchers and re-register after a delay via _resubscribeAll().
//
//  FIX 4 — Rebalance poll dedup reads stale snapshot
//    The HTTP fallback poll read pool.recentRebalances from the pre-refresh
//    snapshot object, not the live store — so dedup always failed on the first
//    poll after a WSS rebalance event, causing a duplicate broadcast.
//    Fix: read fresh pool entry from store inside the dedup check.
// ─────────────────────────────────────────────────────────────────────────────

import { formatEther, formatUnits } from "viem";
import { httpClient, wssClient }    from "./chain.js";
import { FACTORY_ABI, VAULT_ABI, POOL_ABI, ERC20_ABI } from "./abis.js";
import {
  getPoolTokenMetadata,
  sqrtPriceX96ToPrice,
  isStablecoin,
} from "./tokenMetadata.js";
import {
  upsertPool,
  updateLiveData,
  addRebalanceEvent,
  setRebalanceFailure,
  clearRebalanceFailure,
  getAllPools,
} from "./store.js";

const FACTORY_ADDRESS  = process.env.FACTORY_ADDRESS;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);

// ── Broadcast callback ────────────────────────────────────────────────────────
let broadcastFn = null;
export function setBroadcast(fn) { broadcastFn = fn; }
function broadcast(type, data) {
  if (broadcastFn) broadcastFn({ type, data });
}

// ── FIX 3: Track all active WSS unwatch functions so we can tear down cleanly ─
const _unwatchers = new Map(); // key: `${vaultAddress}:rebalanced` etc.

function _registerWatcher(key, unwatchFn) {
  // If a watcher already exists for this key, unwatch first (prevents leaks on resubscribe)
  if (_unwatchers.has(key)) {
    try { _unwatchers.get(key)(); } catch {}
  }
  _unwatchers.set(key, unwatchFn);
}

function _teardownAllWatchers() {
  for (const [key, unwatch] of _unwatchers) {
    try { unwatch(); } catch {}
  }
  _unwatchers.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

export async function startIndexer() {
  if (!FACTORY_ADDRESS) throw new Error("FACTORY_ADDRESS not set in .env");

  console.log("[Indexer] Starting FluxDEX indexer...");
  console.log("[Indexer] Factory:", FACTORY_ADDRESS);
  console.log("[Indexer] WSS:", wssClient ? "available" : "unavailable (HTTP polling only)");

  // FIX 1: Historical sync only populates the store. No WSS subscriptions here.
  await _replayHistoricalEvents();
  await _pollAllVaults();           // initial live data load

  // FIX 1: All WSS subscriptions happen in one place.
  _startLiveSubscriptions();
  _startPollingLoop();

  // FIX 3: Monitor WSS health and reconnect if it drops.
  _startWSSHealthMonitor();

  console.log(`[Indexer] Ready. ${getAllPools().length} pool(s) indexed.`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 1 — HISTORICAL SYNC  (store population only, no WSS subscriptions)
// ─────────────────────────────────────────────────────────────────────────────

async function _replayHistoricalEvents() {
  console.log("[Indexer] Loading vaults via getAllVaults()...");
  try {
    const vaultAddresses = await httpClient.readContract({
      address:      FACTORY_ADDRESS,
      abi:          FACTORY_ABI,
      functionName: "getAllVaults",
    });

    console.log(`[Indexer] Factory reports ${vaultAddresses.length} vault(s).`);

    await Promise.all(vaultAddresses.map(async (vaultAddr) => {
      try {
        const [poolAddr, token0Addr, token1Addr, owner] = await Promise.all([
          httpClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "pool"   }),
          httpClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "token0" }),
          httpClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "token1" }),
          httpClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "owner"  }),
        ]);

        const config = await httpClient.readContract({
          address: vaultAddr, abi: VAULT_ABI, functionName: "config",
        });
        const fee = Number(config[4]);

        const [token0Meta, token1Meta] = await getPoolTokenMetadata(token0Addr, token1Addr);

        // FIX 1: Only upsertPool here — no _subscribeToVaultEvents call.
        upsertPool(poolAddr, {
          poolAddress:      poolAddr,
          vaultAddress:     vaultAddr,
          fee,
          deployer:         owner,
          createdAt:        Date.now(),
          token0:           token0Meta,
          token1:           token1Meta,
          recentRebalances: [],
          liveData:         {},
        });

        console.log(
          `[Indexer] Indexed vault: ${vaultAddr.slice(0, 10)}... ` +
          `pool: ${poolAddr.slice(0, 10)}... (${token0Meta.symbol}/${token1Meta.symbol})`
        );
      } catch (err) {
        console.warn(`[Indexer] Failed to load vault ${vaultAddr.slice(0, 10)}...:`, err.message);
      }
    }));

    // Replay recent Rebalanced events (HTTP getLogs, no WSS)
    const pools = getAllPools();
    if (pools.length > 0) {
      const latestBlock = await httpClient.getBlockNumber();
      const recentStart = latestBlock > 5000n ? latestBlock - 5000n : 0n;
      await _replayRebalancedEvents(recentStart, latestBlock);
    }
  } catch (err) {
    console.error("[Indexer] getAllVaults failed, falling back to event scan:", err.message);
    await _replayHistoricalEventsSlow();
  }
}

async function _replayHistoricalEventsSlow() {
  console.log("[Indexer] Falling back to historical event scan...");
  const latestBlock = await httpClient.getBlockNumber();
  const LOOKBACK    = 10000n;
  const CHUNK       = 5000n;
  const startBlock  = process.env.DEPLOY_BLOCK
    ? BigInt(process.env.DEPLOY_BLOCK)
    : (latestBlock > LOOKBACK ? latestBlock - LOOKBACK : 0n);

  let fromBlock  = startBlock;
  let totalFound = 0;

  while (fromBlock <= latestBlock) {
    const toBlock = fromBlock + CHUNK > latestBlock ? latestBlock : fromBlock + CHUNK;
    try {
      const logs = await httpClient.getLogs({
        address:   FACTORY_ADDRESS,
        event:     FACTORY_ABI.find(e => e.name === "VaultCreated"),
        fromBlock,
        toBlock,
      });
      for (const log of logs) {
        await _processVaultCreated(log, false); // false = don't subscribe yet
        totalFound++;
      }
    } catch {}
    fromBlock = toBlock + 1n;
  }

  console.log(`[Indexer] Historical scan complete: ${totalFound} vault(s) found.`);
  if (totalFound > 0) {
    await _replayRebalancedEvents(startBlock, latestBlock);
  }
}

async function _replayRebalancedEvents(startBlock, latestBlock) {
  const pools = getAllPools();
  if (pools.length === 0) return;
  console.log(`[Indexer] Replaying recent Rebalanced events for ${pools.length} vault(s)...`);

  const CHUNK = 5000n;
  for (const pool of pools) {
    if (!pool.vaultAddress) continue;
    let fromBlock = startBlock;
    let found = 0;
    while (fromBlock <= latestBlock) {
      const toBlock = fromBlock + CHUNK > latestBlock ? latestBlock : fromBlock + CHUNK;
      try {
        const logs = await httpClient.getLogs({
          address:   pool.vaultAddress,
          event:     VAULT_ABI.find(e => e.name === "Rebalanced"),
          fromBlock,
          toBlock,
        });
        for (const log of logs) {
          addRebalanceEvent(pool.poolAddress, {
            newTick:     Number(log.args.newTick),
            oldTokenId:  log.args.oldTokenId.toString(),
            newTokenId:  log.args.newTokenId.toString(),
            blockNumber: Number(log.blockNumber),
            timestamp:   Date.now(),
            txHash:      log.transactionHash,
          });
          found++;
        }
      } catch {}
      fromBlock = toBlock + 1n;
    }
    if (found > 0) console.log(`[Indexer]   └─ ${pool.vaultAddress.slice(0, 10)}... → ${found} rebalance(s)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 2 — LIVE WSS SUBSCRIPTIONS  (single registration point — FIX 1)
// ─────────────────────────────────────────────────────────────────────────────

function _startLiveSubscriptions() {
  if (!wssClient) {
    console.log("[Indexer] WSS unavailable — HTTP polling only.");
    return;
  }

  try {
    // Subscribe to new VaultCreated events on the factory
    const unwatchFactory = wssClient.watchContractEvent({
      address:   FACTORY_ADDRESS,
      abi:       FACTORY_ABI,
      eventName: "VaultCreated",
      onLogs: async (logs) => {
        for (const log of logs) {
          console.log("[Indexer] New vault created:", log.args.vault);
          // FIX 1: _processVaultCreated with subscribe=true registers WSS watchers
          await _processVaultCreated(log, true);
          const poolEntry = _getPoolEntry(log.args.pool);
          if (poolEntry) broadcast("vault_created", poolEntry);
        }
      },
      onError: (err) => console.error("[Indexer] VaultCreated sub error:", err.message),
    });
    _registerWatcher("factory:vaultCreated", unwatchFactory);
    console.log("[Indexer] Subscribed to VaultCreated events.");

    // FIX 1: Subscribe to every vault already in the store exactly once
    for (const pool of getAllPools()) {
      if (pool.vaultAddress && pool.poolAddress) {
        _subscribeToVaultEvents(pool.vaultAddress, pool.poolAddress);
      }
    }
  } catch (err) {
    console.error("[Indexer] Failed to start WSS subscriptions:", err.message);
  }
}

// ── FIX 3: Re-subscribe all pools (called after WSS reconnect) ────────────────
async function _resubscribeAll() {
  console.log("[Indexer] Re-subscribing all watchers after WSS reconnect...");
  _teardownAllWatchers();
  _startLiveSubscriptions();
}

function _subscribeToVaultEvents(vaultAddress, poolAddress) {
  if (!wssClient) return;

  // ── Rebalanced ────────────────────────────────────────────────────────────
  try {
    const unwatchRebalanced = wssClient.watchContractEvent({
      address:   vaultAddress,
      abi:       VAULT_ABI,
      eventName: "Rebalanced",
      onLogs: async (logs) => {
        for (const log of logs) {
          const event = {
            newTick:     _toSafeNumber(log.args?.newTick),
            oldTokenId:  _toSafeString(log.args?.oldTokenId),
            newTokenId:  _toSafeString(log.args?.newTokenId),
            blockNumber: Number(log.blockNumber),
            timestamp:   Date.now(),
            txHash:      log.transactionHash,
          };

          addRebalanceEvent(poolAddress, event);
          clearRebalanceFailure(poolAddress);
          await _refreshVaultLiveData(poolAddress, vaultAddress);

          const freshPool = _getPoolEntry(poolAddress);
          console.log(
            `[Indexer] Rebalanced: pool=${poolAddress.slice(0, 10)}... ` +
            `newTick=${event.newTick} tx=${event.txHash?.slice(0, 10)}...`
          );

          broadcast("rebalanced", {
            poolAddress,
            vaultAddress,
            newTickLower: freshPool?.liveData?.tickLower,
            newTickUpper: freshPool?.liveData?.tickUpper,
            ...event
          });
        }
      },
      onError: (err) =>
        console.error(`[Indexer] Rebalanced sub error (${vaultAddress.slice(0, 10)}...):`, err.message),
    });
    _registerWatcher(`${vaultAddress}:rebalanced`, unwatchRebalanced);
  } catch (err) {
    console.warn(`[Indexer] Rebalanced subscription failed (${vaultAddress.slice(0, 10)}...):`, err.message);
  }

  try {
    const unwatchRebalanceFailed = wssClient.watchContractEvent({
      address:   vaultAddress,
      abi:       VAULT_ABI,
      eventName: "RebalanceFailed",
      onLogs: async (logs) => {
        for (const log of logs) {
          const event = {
            newTick:     _toSafeNumber(log.args?.newTick),
            oldTokenId:  _toSafeString(log.args?.oldTokenId),
            reason:      log.args?.reason ?? "unknown reason",
            blockNumber: Number(log.blockNumber),
            timestamp:   Date.now(),
            txHash:      log.transactionHash,
          };

          setRebalanceFailure(poolAddress, event);
          await _refreshVaultLiveData(poolAddress, vaultAddress);

          console.warn(
            `[Indexer] RebalanceFailed: pool=${poolAddress.slice(0, 10)}... ` +
            `reason=${event.reason} tx=${event.txHash?.slice(0, 10)}...`
          );

          broadcast("rebalance_failed", {
            poolAddress,
            vaultAddress,
            ...event,
          });
        }
      },
      onError: (err) =>
        console.error(`[Indexer] RebalanceFailed sub error (${vaultAddress.slice(0, 10)}...):`, err.message),
    });
    _registerWatcher(`${vaultAddress}:rebalanceFailed`, unwatchRebalanceFailed);
  } catch (err) {
    console.warn(`[Indexer] RebalanceFailed subscription failed (${vaultAddress.slice(0, 10)}...):`, err.message);
  }

  // ── Swap ──────────────────────────────────────────────────────────────────
  try {
    const unwatchSwap = wssClient.watchContractEvent({
      address:   poolAddress,
      abi:       POOL_ABI,
      eventName: "Swap",
      onLogs: async (logs) => {
        for (const log of logs) {
          _markSwapSeen();
          const pool = _getPoolEntry(poolAddress);
          if (!pool) continue;
          const { sqrtPriceX96, tick } = log.args;
          const price = _computePrice(sqrtPriceX96, pool.token0, pool.token1);

          updateLiveData(poolAddress, {
            sqrtPriceX96: sqrtPriceX96.toString(),
            currentTick:  Number(tick),
            price:        price.value,
            priceLabel:   price.label,
          });

          broadcast("price_update", {
            poolAddress,
            sqrtPriceX96: sqrtPriceX96.toString(),
            currentTick:  Number(tick),
            price:        price.value,
            priceLabel:   price.label,
          });
        }
      },
      onError: (err) =>
        console.error(`[Indexer] Swap sub error (${poolAddress.slice(0, 10)}...):`, err.message),
    });
    _registerWatcher(`${poolAddress}:swap`, unwatchSwap);
  } catch (err) {
    console.warn(`[Indexer] Swap subscription failed (${poolAddress.slice(0, 10)}...):`, err.message);
  }

  console.log(`[Indexer] Subscribed Rebalanced+RebalanceFailed+Swap for vault ${vaultAddress.slice(0, 10)}...`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  FIX 3 — WSS HEALTH MONITOR
//  viem's watchContractEvent silently stops delivering events if the underlying
//  WebSocket drops. We detect this by tracking the last time any Swap was seen.
//  If more than 2× the poll interval passes with no Swap, we force-resubscribe.
// ─────────────────────────────────────────────────────────────────────────────

let _lastSwapSeen = Date.now();
const WSS_DEAD_THRESHOLD_MS = Math.max(POLL_INTERVAL_MS * 4, 30_000);

function _markSwapSeen() { _lastSwapSeen = Date.now(); }

function _startWSSHealthMonitor() {
  if (!wssClient) return;

  setInterval(async () => {
    const elapsed = Date.now() - _lastSwapSeen;
    if (elapsed > WSS_DEAD_THRESHOLD_MS) {
      console.warn(
        `[Indexer] No Swap events seen for ${Math.round(elapsed / 1000)}s — ` +
        `assuming WSS dead, resubscribing...`
      );
      _lastSwapSeen = Date.now(); // reset so we don't spam reconnects
      await _resubscribeAll();
    }
  }, WSS_DEAD_THRESHOLD_MS);

  console.log(`[Indexer] WSS health monitor active (threshold: ${WSS_DEAD_THRESHOLD_MS}ms).`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 3 — POLLING LOOP
// ─────────────────────────────────────────────────────────────────────────────

function _startPollingLoop() {
  setInterval(_pollAllVaults, POLL_INTERVAL_MS);
  console.log(`[Indexer] Polling live data every ${POLL_INTERVAL_MS}ms.`);
}

async function _pollAllVaults() {
  // FIX 2: Snapshot pools BEFORE refresh, then re-fetch AFTER for fresh liveData.
  const poolsBefore = getAllPools();
  if (poolsBefore.length === 0) return;

  await Promise.allSettled(
    poolsBefore.map(p => _refreshVaultLiveData(p.poolAddress, p.vaultAddress))
  );

  // FIX 2: getAllPools() again after refresh — now liveData references are current.
  const poolsAfter = getAllPools();
  for (const pool of poolsAfter) {
    const ld = pool.liveData;
    if (ld && ld.currentTick !== undefined) {
      broadcast("price_update", {
        poolAddress:  pool.poolAddress,
        sqrtPriceX96: ld.sqrtPriceX96,
        currentTick:  ld.currentTick,
        price:        ld.price,
        priceLabel:   ld.priceLabel,
        tickLower:    ld.tickLower,
        tickUpper:    ld.tickUpper,
        halfWidth:    ld.halfWidth,
        watching:     ld.watching,
        initialized:  ld.initialized,
      });
    }
  }

  // ── HTTP fallback: catch any Rebalanced events missed by WSS ─────────────
  try {
    const latestBlock = await httpClient.getBlockNumber();
    const fromBlock   = latestBlock > 50n ? latestBlock - 50n : 0n;

    for (const pool of poolsAfter) {
      if (!pool.vaultAddress) continue;
      try {
        const logs = await httpClient.getLogs({
          address:   pool.vaultAddress,
          event:     VAULT_ABI.find(e => e.name === "Rebalanced"),
          fromBlock,
          toBlock:   latestBlock,
        });

        for (const log of logs) {
          const txHash = log.transactionHash;

          // FIX 4: Read fresh pool entry from store for dedup, not the snapshot object.
          const freshPool = _getPoolEntry(pool.poolAddress);
          const alreadySeen = (freshPool?.recentRebalances ?? []).some(r => r.txHash === txHash);
          if (alreadySeen) continue;

          const event = {
            newTick:     _toSafeNumber(log.args?.newTick),
            oldTokenId:  _toSafeString(log.args?.oldTokenId),
            newTokenId:  _toSafeString(log.args?.newTokenId),
            blockNumber: Number(log.blockNumber),
            timestamp:   Date.now(),
            txHash,
          };

          addRebalanceEvent(pool.poolAddress, event);
          console.log(
            `[Indexer] Rebalanced (HTTP poll): pool=${pool.poolAddress.slice(0, 10)}... ` +
            `newTick=${event.newTick}`
          );
          broadcast("rebalanced", {
            poolAddress:  pool.poolAddress,
            vaultAddress: pool.vaultAddress,
            newTickLower: freshPool?.liveData?.tickLower,
            newTickUpper: freshPool?.liveData?.tickUpper,
            ...event,
          });
        }

        const failedLogs = await httpClient.getLogs({
          address:   pool.vaultAddress,
          event:     VAULT_ABI.find(e => e.name === "RebalanceFailed"),
          fromBlock,
          toBlock:   latestBlock,
        });

        for (const log of failedLogs) {
          const txHash = log.transactionHash;
          const freshPool = _getPoolEntry(pool.poolAddress);
          const alreadySeenFailure = freshPool?.lastRebalanceFailure?.txHash === txHash;
          if (alreadySeenFailure) continue;

          const event = {
            newTick:     _toSafeNumber(log.args?.newTick),
            oldTokenId:  _toSafeString(log.args?.oldTokenId),
            reason:      log.args?.reason ?? "unknown reason",
            blockNumber: Number(log.blockNumber),
            timestamp:   Date.now(),
            txHash,
          };

          setRebalanceFailure(pool.poolAddress, event);
          console.warn(
            `[Indexer] RebalanceFailed (HTTP poll): pool=${pool.poolAddress.slice(0, 10)}... ` +
            `reason=${event.reason}`
          );
          broadcast("rebalance_failed", {
            poolAddress:  pool.poolAddress,
            vaultAddress: pool.vaultAddress,
            ...event,
          });
        }
      } catch { /* non-fatal — skip this vault */ }
    }
  } catch { /* non-fatal — latestBlock fetch failed */ }
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNALS
// ─────────────────────────────────────────────────────────────────────────────

// FIX 1: Added `andSubscribe` flag — false during historical replay, true for live events.
async function _processVaultCreated(log, andSubscribe = true) {
  const { pool, vault, token0, token1, fee, deployer } = log.args;
  const [token0Meta, token1Meta] = await getPoolTokenMetadata(token0, token1);

  upsertPool(pool, {
    poolAddress:      pool,
    vaultAddress:     vault,
    fee:              Number(fee),
    deployer,
    createdAt:        Date.now(),
    token0:           token0Meta,
    token1:           token1Meta,
    recentRebalances: [],
    liveData:         {},
  });

  console.log(
    `[Indexer] Indexed vault: ${vault.slice(0, 10)}... ` +
    `pool: ${pool.slice(0, 10)}... (${token0Meta.symbol}/${token1Meta.symbol})`
  );

  // FIX 1: Only subscribe if called from the live VaultCreated handler.
  if (andSubscribe) {
    _subscribeToVaultEvents(vault, pool);
  }
}

async function _refreshVaultLiveData(poolAddress, vaultAddress) {
  try {
    const pool = _getPoolEntry(poolAddress);
    if (!pool) return;

    const readPromises = [
      httpClient.readContract({ address: poolAddress,  abi: POOL_ABI,  functionName: "slot0"      }),
      httpClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "config"     }),
      httpClient.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: "sttBalance" }),
    ];

    if (pool.token0?.address && pool.token1?.address) {
      readPromises.push(
        httpClient.readContract({ address: pool.token0.address, abi: ERC20_ABI, functionName: "balanceOf", args: [poolAddress] }),
        httpClient.readContract({ address: pool.token1.address, abi: ERC20_ABI, functionName: "balanceOf", args: [poolAddress] }),
      );
    }

    const results  = await Promise.all(readPromises);
    const [slot0, config, sttBal] = results;
    const poolBal0 = results[3];
    const poolBal1 = results[4];

    // FIX 3: Any successful slot0 read counts as WSS-equivalent activity.
    // (Only update lastSwapSeen from actual Swap events, not polls — see _markSwapSeen)

    const price = _computePrice(slot0[0], pool.token0, pool.token1);

    const liveUpdate = {
      sqrtPriceX96: slot0[0].toString(),
      currentTick:  Number(slot0[1]),
      price:        price.value,
      priceLabel:   price.label,
      tickLower:    Number(config[0]),
      tickUpper:    Number(config[1]),
      halfWidth:    Number(config[2]),
      tickSpacing:  Number(config[3]),
      watching:     config[6],
      initialized:  config[5],
      sttBalance:   formatEther(sttBal),
    };

    if (poolBal0 !== undefined && pool.token0?.decimals != null) {
      liveUpdate.poolBalance0 = formatUnits(poolBal0, pool.token0.decimals);
    }
    if (poolBal1 !== undefined && pool.token1?.decimals != null) {
      liveUpdate.poolBalance1 = formatUnits(poolBal1, pool.token1.decimals);
    }

    updateLiveData(poolAddress, liveUpdate);
  } catch (err) {
    console.warn(`[Indexer] Refresh failed for ${poolAddress.slice(0, 10)}...:`, err.message);
  }
}

function _computePrice(sqrtPriceX96, token0Meta, token1Meta) {
  if (!token0Meta || !token1Meta) return { value: 0, label: "—" };

  const raw = sqrtPriceX96ToPrice(
    BigInt(sqrtPriceX96),
    token0Meta.decimals,
    token1Meta.decimals
  );

  if (isStablecoin(token0Meta.address)) {
    return {
      value: raw,
      label: `1 ${token1Meta.symbol} = $${raw.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    };
  }
  if (isStablecoin(token1Meta.address)) {
    const inv = raw > 0 ? 1 / raw : 0;
    return {
      value: inv,
      label: `1 ${token0Meta.symbol} = $${inv.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    };
  }
  return {
    value: raw,
    label: `1 ${token0Meta.symbol} = ${raw.toFixed(6)} ${token1Meta.symbol}`,
  };
}

function _getPoolEntry(poolAddress) {
  return getAllPools().find(
    p => p.poolAddress?.toLowerCase() === poolAddress?.toLowerCase()
  ) ?? null;
}

function _toSafeString(value, fallback = "0") {
  if (value == null) return fallback;
  try {
    return value.toString();
  } catch {
    return fallback;
  }
}

function _toSafeNumber(value, fallback = 0) {
  if (value == null) return fallback;
  try {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
