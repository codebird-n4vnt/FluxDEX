// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — indexer.js
//  Core indexer. Does three things:
//
//  1. HISTORICAL SYNC
//     On startup, replays all past VaultCreated + Rebalanced events from chain.
//
//  2. LIVE EVENT SUBSCRIPTION
//     Watches for new VaultCreated events and Rebalanced events via WSS.
//     Falls back to HTTP polling if WSS is unavailable.
//
//  3. LIVE DATA POLLING
//     Every POLL_INTERVAL_MS, refreshes pool.slot0() and vault.config()
//     for all indexed pools.
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
  getAllPools,
} from "./store.js";

const FACTORY_ADDRESS  = process.env.FACTORY_ADDRESS;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);

// ── Broadcast callback — set by Socket.io server so indexer can push updates ──
let broadcastFn = null;
export function setBroadcast(fn) { broadcastFn = fn; }

function broadcast(type, data) {
  if (broadcastFn) broadcastFn({ type, data });
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

export async function startIndexer() {
  if (!FACTORY_ADDRESS) {
    throw new Error("FACTORY_ADDRESS not set in .env");
  }

  console.log("[Indexer] Starting FluxDEX indexer...");
  console.log("[Indexer] Factory:", FACTORY_ADDRESS);
  console.log("[Indexer] RPC:", process.env.RPC_URL || "(default)");
  console.log("[Indexer] WSS:", wssClient ? "available" : "unavailable (HTTP polling only)");

  await _replayHistoricalEvents();
  await _pollAllVaults();         // initial live data load
  _startLiveSubscriptions();
  _startPollingLoop();

  const poolCount = getAllPools().length;
  console.log(`[Indexer] Ready. ${poolCount} pool(s) indexed.`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 1 — HISTORICAL SYNC
// ─────────────────────────────────────────────────────────────────────────────

async function _replayHistoricalEvents() {
  console.log("[Indexer] Loading vaults via getAllVaults() (fast path)...");

  try {
    // ── FAST PATH: Single RPC call to get all vault addresses ────────────
    const vaultAddresses = await httpClient.readContract({
      address: FACTORY_ADDRESS,
      abi:     FACTORY_ABI,
      functionName: "getAllVaults",
    });

    console.log(`[Indexer] Factory reports ${vaultAddresses.length} vault(s).`);

    // ── For each vault, read its on-chain state in parallel ─────────────
    const vaultPromises = vaultAddresses.map(async (vaultAddr) => {
      try {
        // Read vault's pool, token0, token1, config in parallel
        const [poolAddr, token0Addr, token1Addr, owner] = await Promise.all([
          httpClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "pool" }),
          httpClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "token0" }),
          httpClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "token1" }),
          httpClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "owner" }),
        ]);

        // Read pool fee from the vault's config
        const config = await httpClient.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: "config" });
        const fee = Number(config[4]); // poolFee is at index 4

        // Resolve token metadata
        const [token0Meta, token1Meta] = await getPoolTokenMetadata(token0Addr, token1Addr);

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

        console.log(`[Indexer] Indexed vault: ${vaultAddr.slice(0, 10)}... pool: ${poolAddr.slice(0, 10)}... (${token0Meta.symbol}/${token1Meta.symbol})`);

        // Start WSS subscriptions for this vault
        _subscribeToVaultEvents(vaultAddr, poolAddr);
      } catch (err) {
        console.warn(`[Indexer] Failed to load vault ${vaultAddr.slice(0, 10)}...:`, err.message);
      }
    });

    await Promise.all(vaultPromises);

    // ── Replay only RECENT Rebalanced events (last 5000 blocks) ─────────
    const pools = getAllPools();
    if (pools.length > 0) {
      const latestBlock = await httpClient.getBlockNumber();
      const recentStart = latestBlock > 5000n ? latestBlock - 5000n : 0n;
      await _replayRebalancedEvents(recentStart, latestBlock);
    }

  } catch (err) {
    console.error("[Indexer] Fast vault loading failed, falling back to event scan:", err.message);
    // Fallback to the old slow method
    await _replayHistoricalEventsSlow();
  }
}

// ── SLOW FALLBACK: Original event scanning (used if getAllVaults fails) ────
async function _replayHistoricalEventsSlow() {
  console.log("[Indexer] Falling back to historical event scan...");

  const latestBlock = await httpClient.getBlockNumber();
  const LOOKBACK_BLOCKS = 10000n; // Reduced from 50000
  const CHUNK_SIZE  = 5000n;      // Increased from 900

  const deployBlock = process.env.DEPLOY_BLOCK ? BigInt(process.env.DEPLOY_BLOCK) : null;
  const startBlock = deployBlock ?? (latestBlock > LOOKBACK_BLOCKS ? latestBlock - LOOKBACK_BLOCKS : 0n);
  let fromBlock = startBlock;
  let totalFound = 0;

  console.log(`[Indexer] Scanning blocks ${startBlock} → ${latestBlock} (latest: ${latestBlock})`);

  while (fromBlock <= latestBlock) {
    const toBlock = fromBlock + CHUNK_SIZE > latestBlock
      ? latestBlock
      : fromBlock + CHUNK_SIZE;

    try {
      const logs = await httpClient.getLogs({
        address:   FACTORY_ADDRESS,
        event:     FACTORY_ABI.find(e => e.name === "VaultCreated"),
        fromBlock,
        toBlock,
      });

      for (const log of logs) {
        await _processVaultCreated(log);
        totalFound++;
      }
    } catch (err) {
      if (!err.message.includes("missing block data")) {
        console.warn(`[Indexer] getLogs failed for blocks ${fromBlock}-${toBlock}:`, err.message);
      }
    }

    fromBlock = toBlock + 1n;
  }

  console.log(`[Indexer] Historical sync complete: ${totalFound} vault(s) found.`);

  if (totalFound > 0) {
    await _replayRebalancedEvents(startBlock, latestBlock);
  }
}

async function _replayRebalancedEvents(startBlock, latestBlock) {
  const pools = getAllPools();
  console.log(`[Indexer] Replaying historical Rebalanced events for ${pools.length} vault(s)...`);

  const CHUNK_SIZE = 5000n;

  for (const pool of pools) {
    if (!pool.vaultAddress) continue;
    let fromBlock = startBlock;
    let found = 0;

    while (fromBlock <= latestBlock) {
      const toBlock = fromBlock + CHUNK_SIZE > latestBlock
        ? latestBlock
        : fromBlock + CHUNK_SIZE;

      try {
        const logs = await httpClient.getLogs({
          address: pool.vaultAddress,
          event:   VAULT_ABI.find(e => e.name === "Rebalanced"),
          fromBlock,
          toBlock,
        });

        for (const log of logs) {
          const event = {
            newTick:     Number(log.args.newTick),
            oldTokenId:  log.args.oldTokenId.toString(),
            newTokenId:  log.args.newTokenId.toString(),
            blockNumber: Number(log.blockNumber),
            timestamp:   Date.now(), // approximate
            txHash:      log.transactionHash,
          };
          addRebalanceEvent(pool.poolAddress, event);
          found++;
        }
      } catch (err) {
        // Non-fatal — skip chunk
      }

      fromBlock = toBlock + 1n;
    }

    if (found > 0) {
      console.log(`[Indexer]   └─ ${pool.vaultAddress.slice(0, 10)}... → ${found} rebalance(s)`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 2 — LIVE EVENT SUBSCRIPTIONS (WSS with fallback)
// ─────────────────────────────────────────────────────────────────────────────

function _startLiveSubscriptions() {
  if (!wssClient) {
    console.log("[Indexer] WSS unavailable — relying on HTTP polling only.");
    return;
  }

  try {
    // ── Subscribe to new VaultCreated events ───────────────────────────────
    wssClient.watchContractEvent({
      address:   FACTORY_ADDRESS,
      abi:       FACTORY_ABI,
      eventName: "VaultCreated",
      onLogs: async (logs) => {
        for (const log of logs) {
          console.log("[Indexer] New vault created:", log.args.vault);
          await _processVaultCreated(log);

          // Broadcast the full pool entry (with metadata already resolved)
          const poolEntry = _getPoolEntry(log.args.pool);
          broadcast("vault_created", poolEntry);
        }
      },
      onError: (err) => {
        console.error("[Indexer] VaultCreated subscription error:", err.message);
      },
    });

    console.log("[Indexer] Subscribed to VaultCreated events via WSS.");

    // Subscribe to Rebalanced + Swap events for each existing vault
    const pools = getAllPools();
    for (const pool of pools) {
      if (pool.vaultAddress && pool.poolAddress) {
        _subscribeToVaultEvents(pool.vaultAddress, pool.poolAddress);
      }
    }
  } catch (err) {
    console.error("[Indexer] Failed to start WSS subscriptions:", err.message);
    console.log("[Indexer] Falling back to HTTP polling only.");
  }
}

// ── Subscribe to Rebalanced events for a specific vault ──────────────────────
function _subscribeToVaultEvents(vaultAddress, poolAddress) {
  if (!wssClient) return;

  try {
    wssClient.watchContractEvent({
      address:   vaultAddress,
      abi:       VAULT_ABI,
      eventName: "Rebalanced",
      onLogs: async (logs) => {
        for (const log of logs) {
          const event = {
            newTick:     Number(log.args.newTick),
            oldTokenId:  log.args.oldTokenId.toString(),
            newTokenId:  log.args.newTokenId.toString(),
            blockNumber: Number(log.blockNumber),
            timestamp:   Date.now(),
            txHash:      log.transactionHash,
          };

          addRebalanceEvent(poolAddress, event);

          // Refresh live data immediately after a rebalance
          await _refreshVaultLiveData(poolAddress, vaultAddress);

          console.log(
            `[Indexer] Rebalanced: pool=${poolAddress.slice(0, 10)}... newTick=${event.newTick}`
          );

          broadcast("rebalanced", {
            poolAddress,
            vaultAddress,
            ...event,
          });
        }
      },
      onError: (err) => {
        console.error(`[Indexer] Rebalanced sub error (${vaultAddress.slice(0, 10)}...):`, err.message);
      },
    });

    // Also subscribe to Swap events on the pool for live price updates
    wssClient.watchContractEvent({
      address:   poolAddress,
      abi:       POOL_ABI,
      eventName: "Swap",
      onLogs: async (logs) => {
        for (const log of logs) {
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
      onError: (err) => {
        console.error(`[Indexer] Swap sub error (${poolAddress.slice(0, 10)}...):`, err.message);
      },
    });

    console.log(`[Indexer] Subscribed to Rebalanced+Swap for vault ${vaultAddress.slice(0, 10)}...`);
  } catch (err) {
    console.warn(`[Indexer] WSS subscription failed for ${vaultAddress.slice(0, 10)}...:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 3 — POLLING LOOP
// ─────────────────────────────────────────────────────────────────────────────

function _startPollingLoop() {
  setInterval(async () => {
    await _pollAllVaults();
  }, POLL_INTERVAL_MS);

  console.log(`[Indexer] Polling live data every ${POLL_INTERVAL_MS}ms.`);
}

async function _pollAllVaults() {
  const pools = getAllPools();
  if (pools.length === 0) return;

  const results = await Promise.allSettled(
    pools.map(p => _refreshVaultLiveData(p.poolAddress, p.vaultAddress))
  );

  // Broadcast price updates for all successfully refreshed pools
  for (let i = 0; i < pools.length; i++) {
    if (results[i].status === "fulfilled") {
      const pool = pools[i];
      const liveData = pool.liveData;
      if (liveData && liveData.currentTick !== undefined) {
        broadcast("price_update", {
          poolAddress:  pool.poolAddress,
          sqrtPriceX96: liveData.sqrtPriceX96,
          currentTick:  liveData.currentTick,
          price:        liveData.price,
          priceLabel:   liveData.priceLabel,
          tickLower:    liveData.tickLower,
          tickUpper:    liveData.tickUpper,
          watching:     liveData.watching,
          initialized:  liveData.initialized,
        });
      }
    }
  }

  // ── Poll for recent Rebalanced events (HTTP fallback for WSS) ──────────
  try {
    const latestBlock = await httpClient.getBlockNumber();
    const fromBlock = latestBlock > 50n ? latestBlock - 50n : 0n;

    for (const pool of pools) {
      if (!pool.vaultAddress) continue;
      try {
        const logs = await httpClient.getLogs({
          address: pool.vaultAddress,
          event:   VAULT_ABI.find(e => e.name === "Rebalanced"),
          fromBlock,
          toBlock: latestBlock,
        });

        for (const log of logs) {
          const event = {
            newTick:     Number(log.args.newTick),
            oldTokenId:  log.args.oldTokenId.toString(),
            newTokenId:  log.args.newTokenId.toString(),
            blockNumber: Number(log.blockNumber),
            timestamp:   Date.now(),
            txHash:      log.transactionHash,
          };

          // Only add if we haven't seen this tx hash before
          const existing = pool.recentRebalances || [];
          if (!existing.some(r => r.txHash === event.txHash)) {
            addRebalanceEvent(pool.poolAddress, event);
            console.log(
              `[Indexer] Rebalanced (polled): pool=${pool.poolAddress.slice(0, 10)}... newTick=${event.newTick}`
            );
            broadcast("rebalanced", {
              poolAddress: pool.poolAddress,
              vaultAddress: pool.vaultAddress,
              ...event,
            });
          }
        }
      } catch {
        // Non-fatal — skip this vault's rebalance poll
      }
    }
  } catch {
    // Non-fatal — latestBlock fetch failed
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNALS
// ─────────────────────────────────────────────────────────────────────────────

async function _processVaultCreated(log) {
  const { pool, vault, token0, token1, fee, deployer } = log.args;

  // Resolve token metadata (Uniswap list → on-chain fallback)
  const [token0Meta, token1Meta] = await getPoolTokenMetadata(token0, token1);

  upsertPool(pool, {
    poolAddress:      pool,
    vaultAddress:     vault,
    fee:              Number(fee),
    deployer:         deployer,
    createdAt:        Date.now(),
    token0:           token0Meta,
    token1:           token1Meta,
    recentRebalances: [],
    liveData:         {},
  });

  console.log(`[Indexer] Indexed vault: ${vault.slice(0, 10)}... pool: ${pool.slice(0, 10)}... (${token0Meta.symbol}/${token1Meta.symbol})`);

  // Start WSS subscriptions for this vault + pool
  _subscribeToVaultEvents(vault, pool);
}

async function _refreshVaultLiveData(poolAddress, vaultAddress) {
  try {
    const poolContract = {
      address: poolAddress,
      abi:     POOL_ABI,
    };

    const vaultContract = {
      address: vaultAddress,
      abi:     VAULT_ABI,
    };

    const pool = _getPoolEntry(poolAddress);
    if (!pool) return;

    // Batch all reads in parallel — minimises round trips
    // Now also reads pool token balances for liquidity health display
    const readPromises = [
      httpClient.readContract({ ...poolContract,  functionName: "slot0"      }),
      httpClient.readContract({ ...vaultContract, functionName: "config"     }),
      httpClient.readContract({ ...vaultContract, functionName: "sttBalance" }),
    ];

    // Add pool token balance reads if we have token addresses
    if (pool.token0?.address && pool.token1?.address) {
      readPromises.push(
        httpClient.readContract({ address: pool.token0.address, abi: ERC20_ABI, functionName: "balanceOf", args: [poolAddress] }),
        httpClient.readContract({ address: pool.token1.address, abi: ERC20_ABI, functionName: "balanceOf", args: [poolAddress] }),
      );
    }

    const results = await Promise.all(readPromises);
    const [slot0, config, sttBal] = results;
    const poolBal0 = results[3];
    const poolBal1 = results[4];

    const price = _computePrice(slot0[0], pool.token0, pool.token1);

    const liveUpdate = {
      sqrtPriceX96: slot0[0].toString(),
      currentTick:  Number(slot0[1]),
      price:        price.value,
      priceLabel:   price.label,
      tickLower:    Number(config[0]),
      tickUpper:    Number(config[1]),
      halfWidth:    Number(config[2]),
      watching:     config[6],
      initialized:  config[5],
      sttBalance:   formatEther(sttBal),
    };

    // Add pool token balances if available
    if (poolBal0 !== undefined && pool.token0?.decimals != null) {
      liveUpdate.poolBalance0 = formatUnits(poolBal0, pool.token0.decimals);
    }
    if (poolBal1 !== undefined && pool.token1?.decimals != null) {
      liveUpdate.poolBalance1 = formatUnits(poolBal1, pool.token1.decimals);
    }

    updateLiveData(poolAddress, liveUpdate);

  } catch (err) {
    // Non-fatal — poll will retry
    console.warn(`[Indexer] Refresh failed for ${poolAddress.slice(0, 10)}...:`, err.message);
  }
}

function _computePrice(sqrtPriceX96, token0Meta, token1Meta) {
  if (!token0Meta || !token1Meta) {
    return { value: 0, label: "—" };
  }

  const raw = sqrtPriceX96ToPrice(
    BigInt(sqrtPriceX96),
    token0Meta.decimals,
    token1Meta.decimals
  );

  // If token0 is a stablecoin, price = USD value of 1 token1
  if (isStablecoin(token0Meta.address)) {
    return {
      value: raw,
      label: `1 ${token1Meta.symbol} = $${raw.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`,
    };
  }

  // If token1 is a stablecoin, invert
  if (isStablecoin(token1Meta.address)) {
    const inverted = raw > 0 ? 1 / raw : 0;
    return {
      value: inverted,
      label: `1 ${token0Meta.symbol} = $${inverted.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`,
    };
  }

  // Neither is a stablecoin — show ratio
  return {
    value: raw,
    label: `1 ${token0Meta.symbol} = ${raw.toFixed(6)} ${token1Meta.symbol}`,
  };
}

// Helper to get pool entry
function _getPoolEntry(poolAddress) {
  return getAllPools().find(
    p => p.poolAddress?.toLowerCase() === poolAddress.toLowerCase()
  ) ?? null;
}
