// src/lib/abis.ts

// ─────────────────────────────────────────────────────────────────────────────
//  ABIs in JSON format for wagmi useReadContract / useWriteContract
// ─────────────────────────────────────────────────────────────────────────────

export const VAULT_ABI = [
  { type: 'function', name: 'config', inputs: [], outputs: [
    { name: 'tickLower', type: 'int24' },
    { name: 'tickUpper', type: 'int24' },
    { name: 'halfWidth', type: 'int24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'poolFee', type: 'uint24' },
    { name: 'initialized', type: 'bool' },
    { name: 'watching', type: 'bool' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'sttBalance', inputs: [], outputs: [
    { name: '', type: 'uint256' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'owner', inputs: [], outputs: [
    { name: '', type: 'address' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'tokenId', inputs: [], outputs: [
    { name: '', type: 'uint256' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'subscriptionId', inputs: [], outputs: [
    { name: '', type: 'uint256' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'backupSubscriptionId', inputs: [], outputs: [
    { name: '', type: 'uint256' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'pool', inputs: [], outputs: [
    { name: '', type: 'address' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'token0', inputs: [], outputs: [
    { name: '', type: 'address' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'token1', inputs: [], outputs: [
    { name: '', type: 'address' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'adminFundingAddress', inputs: [], outputs: [
    { name: '', type: 'address' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'startWatching', inputs: [
    { name: 'gasLimit', type: 'uint64' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'stopWatching', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'startBackupWatcher', inputs: [
    { name: 'gasLimit', type: 'uint64' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'stopBackupWatcher', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'manualRebalance', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setHalfWidth', inputs: [
    { name: '_halfWidth', type: 'int24' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { type: 'event', name: 'Rebalanced', inputs: [
    { name: 'newTick', type: 'int24', indexed: true },
    { name: 'oldTokenId', type: 'uint256', indexed: false },
    { name: 'newTokenId', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'RebalanceFailed', inputs: [
    { name: 'newTick', type: 'int24', indexed: true },
    { name: 'oldTokenId', type: 'uint256', indexed: false },
    { name: 'reason', type: 'string', indexed: false },
  ] },
  { type: 'event', name: 'WatchingStarted', inputs: [
    { name: 'subscriptionId', type: 'uint256', indexed: true },
  ] },
  { type: 'event', name: 'WatchingStopped', inputs: [
    { name: 'subscriptionId', type: 'uint256', indexed: true },
  ] },
] as const

export const POOL_ABI = [
  { type: 'function', name: 'slot0', inputs: [], outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' },
    { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' },
    { name: 'observationCardinality', type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' },
    { name: 'feeProtocol', type: 'uint8' },
    { name: 'unlocked', type: 'bool' },
  ], stateMutability: 'view' },
] as const

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [
    { name: 'account', type: 'address' },
  ], outputs: [
    { name: '', type: 'uint256' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'allowance', inputs: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
  ], outputs: [
    { name: '', type: 'uint256' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [
    { name: 'spender', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ], outputs: [
    { name: '', type: 'bool' },
  ], stateMutability: 'nonpayable' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [
    { name: '', type: 'string' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [
    { name: '', type: 'uint8' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'name', inputs: [], outputs: [
    { name: '', type: 'string' },
  ], stateMutability: 'view' },
] as const

export const FACTORY_ABI = [
  { type: 'function', name: 'createVault', inputs: [
    { name: 'tokenA', type: 'address' },
    { name: 'tokenB', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'sqrtPriceX96', type: 'uint160' },
    { name: 'amount0Desired', type: 'uint256' },
    { name: 'amount1Desired', type: 'uint256' },
    { name: 'halfWidth', type: 'int24' },
  ], outputs: [
    { name: 'vault', type: 'address' },
    { name: 'pool', type: 'address' },
  ], stateMutability: 'payable' },
  { type: 'function', name: 'getAllVaults', inputs: [], outputs: [
    { name: 'vaults', type: 'address[]' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'vaultByPool', inputs: [
    { name: '', type: 'address' },
  ], outputs: [
    { name: '', type: 'address' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'poolByVault', inputs: [
    { name: '', type: 'address' },
  ], outputs: [
    { name: '', type: 'address' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'vaultCount', inputs: [], outputs: [
    { name: '', type: 'uint256' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'computeSqrtPriceX96', inputs: [
    { name: 'priceNumerator', type: 'uint256' },
    { name: 'priceDenominator', type: 'uint256' },
  ], outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' },
  ], stateMutability: 'pure' },
  // Custom errors for auto-decoding reverts
  { type: 'error', name: 'NotOwner', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'UnsupportedFeeTier', inputs: [{ name: 'fee', type: 'uint24' }] },
  { type: 'error', name: 'VaultAlreadyExists', inputs: [{ name: 'pool', type: 'address' }, { name: 'vault', type: 'address' }] },
  { type: 'error', name: 'InvalidTokenOrder', inputs: [] },
  { type: 'error', name: 'TokenTransferFailed', inputs: [] },
  { type: 'error', name: 'InsufficientSTTFunding', inputs: [{ name: 'required', type: 'uint256' }, { name: 'actual', type: 'uint256' }] },
  { type: 'error', name: 'InsufficientAllowance', inputs: [{ name: 'token', type: 'address' }, { name: 'required', type: 'uint256' }, { name: 'actual', type: 'uint256' }] },
  { type: 'error', name: 'STTTransferFailed', inputs: [] },
  { type: 'event', name: 'VaultCreated', inputs: [
    { name: 'pool', type: 'address', indexed: true },
    { name: 'vault', type: 'address', indexed: true },
    { name: 'token0', type: 'address', indexed: false },
    { name: 'token1', type: 'address', indexed: false },
    { name: 'fee', type: 'uint24', indexed: false },
    { name: 'deployer', type: 'address', indexed: true },
  ] },
] as const

export const ROUTER_ABI = [
  { type: 'function', name: 'exactInputSingle', inputs: [
    { name: 'params', type: 'tuple', components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'recipient', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ] },
  ], outputs: [
    { name: 'amountOut', type: 'uint256' },
  ], stateMutability: 'payable' },
] as const
