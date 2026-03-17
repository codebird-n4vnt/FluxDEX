// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — indexer.js
//  Core indexer. Does three things:
//
//  1. HISTORICAL SYNC
//     On startup, replays all past VaultCreated events from FluxFactory
//     to build the initial pool list.
//
//  2. LIVE EVENT SUBSCRIPTION
//     Watches for new VaultCreated events and Rebalanced events via WSS.
//
//  3. LIVE DATA POLLING
//     Every POLL_INTERVAL_MS, refreshes pool.slot0() and vault.config()
//     for all indexed pools.
// ─────────────────────────────────────────────────────────────────────────────

import { getContract, formatEther } from "viem";
import { httpClient, wssClient }    from "./chain.js";
import { FACTORY_ABI, VAULT_ABI, POOL_ABI } from "./abis.js";
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

// ── Broadcast callback — set by WebSocket server so indexer can push updates ──
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

  await _replayHistoricalEvents();
  await _pollAllVaults();         // initial live data load
  _startLiveSubscriptions();
  _startPollingLoop();

  console.log("[Indexer] Ready.");
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 1 — HISTORICAL SYNC
// ─────────────────────────────────────────────────────────────────────────────

async function _replayHistoricalEvents() {
  console.log("[Indexer] Replaying historical VaultCreated events...");

  // Somnia RPC limits eth_getLogs to 1000 blocks per query.
  // We fetch in 900-block chunks from block 0 to latest.
  const latestBlock = await httpClient.getBlockNumber();
  const CHUNK_SIZE  = 900n;

  let fromBlock = 0n;
  let totalFound = 0;

  while (fromBlock <= latestBlock) {
    const toBlock = fromBlock + CHUNK_SIZE > latestBlock
      ? latestBlock
      : fromBlock + CHUNK_SIZE;

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

    fromBlock = toBlock + 1n;
  }

  console.log(`[Indexer] Historical sync complete: ${totalFound} vault(s) found.`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 2 — LIVE EVENT SUBSCRIPTIONS (WSS)
// ─────────────────────────────────────────────────────────────────────────────

function _startLiveSubscriptions() {
  // ── Subscribe to new VaultCreated events ─────────────────────────────────
  wssClient.watchContractEvent({
    address:   FACTORY_ADDRESS,
    abi:       FACTORY_ABI,
    eventName: "VaultCreated",
    onLogs: async (logs) => {
      for (const log of logs) {
        console.log("[Indexer] New vault created:", log.args.vault);
        await _processVaultCreated(log);
        broadcast("vault_created", _serializePool(log.args.pool));
      }
    },
    onError: (err) => {
      console.error("[Indexer] VaultCreated subscription error:", err.message);
    },
  });

  console.log("[Indexer] Subscribed to VaultCreated events via WSS.");
}

// ── Subscribe to Rebalanced events for a specific vault ──────────────────────
function _subscribeToVaultEvents(vaultAddress, poolAddress) {
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
          `[Indexer] Rebalanced: pool=${poolAddress} newTick=${event.newTick}`
        );

        broadcast("rebalanced", {
          poolAddress,
          vaultAddress,
          ...event,
        });
      }
    },
    onError: (err) => {
      console.error(`[Indexer] Rebalanced subscription error (${vaultAddress}):`, err.message);
    },
  });

  // Also subscribe to Swap events on the pool for live price updates
  wssClient.watchContractEvent({
    address:   poolAddress,
    abi:       POOL_ABI,
    eventName: "Swap",
    onLogs: async (logs) => {
      for (const log of logs) {
        const pool = await _getPoolEntry(poolAddress);
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
      console.error(`[Indexer] Swap subscription error (${poolAddress}):`, err.message);
    },
  });
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

  await Promise.allSettled(
    pools.map(p => _refreshVaultLiveData(p.poolAddress, p.vaultAddress))
  );
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

  // Start WSS subscriptions for this vault + pool
  _subscribeToVaultEvents(vault, pool);
}

async function _refreshVaultLiveData(poolAddress, vaultAddress) {
  try {
    const poolContract = {
      address: poolAddress,
      abi:     POOL_ABI,
      client:  httpClient,
    };

    const vaultContract = {
      address: vaultAddress,
      abi:     VAULT_ABI,
      client:  httpClient,
    };

    // Batch all reads in parallel — minimises round trips
    const [slot0, config, sttBal] = await Promise.all([
      httpClient.readContract({ ...poolContract,  functionName: "slot0"      }),
      httpClient.readContract({ ...vaultContract, functionName: "config"     }),
      httpClient.readContract({ ...vaultContract, functionName: "sttBalance" }),
    ]);

    const pool = _getPoolEntry(poolAddress);
    if (!pool) return;

    const price = _computePrice(slot0[0], pool.token0, pool.token1);

    updateLiveData(poolAddress, {
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
    });

  } catch (err) {
    // Non-fatal — poll will retry
    console.warn(`[Indexer] Failed to refresh live data for ${poolAddress}:`, err.message);
  }
}

function _computePrice(sqrtPriceX96, token0Meta, token1Meta) {
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

// Helper to get pool entry without circular import
function _getPoolEntry(poolAddress) {
  return getAllPools().find(
    p => p.poolAddress?.toLowerCase() === poolAddress.toLowerCase()
  ) ?? null;
}

function _serializePool(poolAddress) {
  return getAllPools().find(
    p => p.poolAddress?.toLowerCase() === poolAddress.toLowerCase()
  );
}
