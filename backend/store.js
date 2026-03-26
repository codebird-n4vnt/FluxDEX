// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — store.js
//  In-memory data store for all indexed pool and vault data.
//
//  Structure per pool entry:
//  {
//    poolAddress:   string,
//    vaultAddress:  string,
//    fee:           number,
//    deployer:      string,
//    createdAt:     number  (unix timestamp),
//    token0:        TokenMetadata,
//    token1:        TokenMetadata,
//    liveData: {
//      sqrtPriceX96: bigint,
//      currentTick:  number,
//      price:        number,   ← human readable (e.g. 1842.57 for USDC/WETH)
//      priceLabel:   string,   ← e.g. "1 WETH = $1,842.57" or "1 A = 0.05 B"
//      tickLower:    number,
//      tickUpper:    number,
//      watching:     boolean,
//      initialized:  boolean,
//      sttBalance:   string,   ← formatted STT
//      lastUpdated:  number,   ← unix timestamp
//    },
//    recentRebalances: [       ← last 10 rebalances
//      {
//        newTick:    number,
//        oldTokenId: string,
//        newTokenId: string,
//        blockNumber: number,
//        timestamp:  number,
//        txHash:     string,
//      }
//    ]
//  }
// ─────────────────────────────────────────────────────────────────────────────

// poolAddress (lowercase) → pool entry
const pools = new Map();

// ── Write operations ──────────────────────────────────────────────────────────

export function upsertPool(poolAddress, data) {
  const key     = poolAddress.toLowerCase();
  const existing = pools.get(key) ?? {};
  pools.set(key, { ...existing, ...data, poolAddress });
}

export function updateLiveData(poolAddress, liveData) {
  const key   = poolAddress.toLowerCase();
  const entry = pools.get(key);
  if (!entry) return;
  entry.liveData = { ...entry.liveData, ...liveData, lastUpdated: Date.now() };
}

export function addRebalanceEvent(poolAddress, event) {
  const key   = poolAddress.toLowerCase();
  const entry = pools.get(key);
  if (!entry) return;

  if (!entry.recentRebalances) entry.recentRebalances = [];

  // Prepend and keep last 10
  entry.recentRebalances = [event, ...entry.recentRebalances].slice(0, 10);
}

export function setRebalanceFailure(poolAddress, failure) {
  const key   = poolAddress.toLowerCase();
  const entry = pools.get(key);
  if (!entry) return;
  entry.lastRebalanceFailure = failure;
}

export function clearRebalanceFailure(poolAddress) {
  const key   = poolAddress.toLowerCase();
  const entry = pools.get(key);
  if (!entry) return;
  delete entry.lastRebalanceFailure;
}

// ── Read operations ───────────────────────────────────────────────────────────

export function getAllPools() {
  return Array.from(pools.values());
}

export function getPoolByAddress(poolAddress) {
  return pools.get(poolAddress.toLowerCase()) ?? null;
}

export function getPoolByVault(vaultAddress) {
  const vaultLower = vaultAddress.toLowerCase();
  for (const entry of pools.values()) {
    if (entry.vaultAddress?.toLowerCase() === vaultLower) return entry;
  }
  return null;
}

export function poolCount() {
  return pools.size;
}
