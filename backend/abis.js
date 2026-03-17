// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — abis.js
//  Minimal ABI fragments for all contracts the backend interacts with.
//  Only includes the functions and events actually used by the indexer.
// ─────────────────────────────────────────────────────────────────────────────

export const FACTORY_ABI = [
  // ── Events ──────────────────────────────────────────────────────────────
  {
    type: "event",
    name: "VaultCreated",
    inputs: [
      { name: "pool",     type: "address", indexed: true  },
      { name: "vault",    type: "address", indexed: true  },
      { name: "token0",   type: "address", indexed: false },
      { name: "token1",   type: "address", indexed: false },
      { name: "fee",      type: "uint24",  indexed: false },
      { name: "deployer", type: "address", indexed: true  },
    ],
  },

  // ── Read functions ───────────────────────────────────────────────────────
  {
    type: "function",
    name: "vaultCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "vaultByIndex",
    stateMutability: "view",
    inputs:  [{ name: "index", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "vaultByPool",
    stateMutability: "view",
    inputs:  [{ name: "pool", type: "address" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "poolByVault",
    stateMutability: "view",
    inputs:  [{ name: "vault", type: "address" }],
    outputs: [{ type: "address" }],
  },
];

export const VAULT_ABI = [
  // ── Events ──────────────────────────────────────────────────────────────
  {
    type: "event",
    name: "Rebalanced",
    inputs: [
      { name: "newTick",    type: "int24",   indexed: true  },
      { name: "oldTokenId", type: "uint256", indexed: false },
      { name: "newTokenId", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "WatchingStarted",
    inputs: [{ name: "subscriptionId", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "WatchingStopped",
    inputs: [{ name: "subscriptionId", type: "uint256", indexed: true }],
  },

  // ── Read functions ───────────────────────────────────────────────────────
  {
    type: "function",
    name: "pool",
    stateMutability: "view",
    inputs:  [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "npm",
    stateMutability: "view",
    inputs:  [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "tokenId",
    stateMutability: "view",
    inputs:  [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "subscriptionId",
    stateMutability: "view",
    inputs:  [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "backupSubscriptionId",
    stateMutability: "view",
    inputs:  [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "sttBalance",
    stateMutability: "view",
    inputs:  [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "lastBackupCheckBlock",
    stateMutability: "view",
    inputs:  [],
    outputs: [{ type: "uint256" }],
  },
  {
    // Returns (tickLower, tickUpper, halfWidth, tickSpacing, poolFee, initialized, watching)
    type: "function",
    name: "config",
    stateMutability: "view",
    inputs:  [],
    outputs: [
      { name: "tickLower",   type: "int24"  },
      { name: "tickUpper",   type: "int24"  },
      { name: "halfWidth",   type: "int24"  },
      { name: "tickSpacing", type: "int24"  },
      { name: "poolFee",     type: "uint24" },
      { name: "initialized", type: "bool"   },
      { name: "watching",    type: "bool"   },
    ],
  },
];

export const POOL_ABI = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96",               type: "uint160" },
      { name: "tick",                        type: "int24"   },
      { name: "observationIndex",            type: "uint16"  },
      { name: "observationCardinality",      type: "uint16"  },
      { name: "observationCardinalityNext",  type: "uint16"  },
      { name: "feeProtocol",                 type: "uint8"   },
      { name: "unlocked",                    type: "bool"    },
    ],
  },
  {
    type: "function",
    name: "fee",
    stateMutability: "view",
    inputs:  [],
    outputs: [{ type: "uint24" }],
  },
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "sender",        type: "address", indexed: true  },
      { name: "recipient",     type: "address", indexed: true  },
      { name: "amount0",       type: "int256",  indexed: false },
      { name: "amount1",       type: "int256",  indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity",     type: "uint128", indexed: false },
      { name: "tick",          type: "int24",   indexed: false },
    ],
  },
];

export const ERC20_ABI = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs:  [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs:  [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs:  [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner",   type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs:  [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];
