import { createPublicClient, http, formatEther } from 'viem';

const VAULT_ABI = [
  { type: 'function', name: 'config', inputs: [], outputs: [
    { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' },
    { name: 'halfWidth', type: 'int24' }, { name: 'tickSpacing', type: 'int24' },
    { name: 'poolFee', type: 'uint24' }, { name: 'initialized', type: 'bool' },
    { name: 'watching', type: 'bool' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'pool', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'tokenId', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'subscriptionId', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'backupSubscriptionId', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'sttBalance', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'token0', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'token1', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
];

const POOL_ABI = [
  { type: 'function', name: 'slot0', inputs: [], outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' },
    { name: 'unlocked', type: 'bool' },
  ], stateMutability: 'view' },
];

const FACTORY_ABI = [
  { type: 'function', name: 'getAllVaults', inputs: [], outputs: [{ name: 'vaults', type: 'address[]' }], stateMutability: 'view' },
];

const client = createPublicClient({
  transport: http('https://dream-rpc.somnia.network'),
});

const FACTORY = '0x3CE6c25CD4a3BB434a31EDDFcd3315cA285B4a49';

async function diagnose() {
  console.log('═══ FluxDEX Vault Diagnostics ═══\n');

  // Get all vaults
  const vaults = await client.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getAllVaults' });
  console.log(`Factory has ${vaults.length} vault(s):\n`);

  for (const vaultAddr of vaults) {
    console.log(`── Vault: ${vaultAddr} ──`);
    
    const [config, poolAddr, owner, tid, subId, backupSubId, sttBal, t0, t1] = await Promise.all([
      client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'config' }),
      client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'pool' }),
      client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'owner' }),
      client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'tokenId' }),
      client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'subscriptionId' }),
      client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'backupSubscriptionId' }),
      client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'sttBalance' }),
      client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'token0' }),
      client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'token1' }),
    ]);

    const nativeBalance = await client.getBalance({ address: vaultAddr });
    
    const slot0 = await client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'slot0' });
    const currentTick = Number(slot0[1]);

    console.log(`  Pool:           ${poolAddr}`);
    console.log(`  Owner:          ${owner}`);
    console.log(`  Token0:         ${t0}`);
    console.log(`  Token1:         ${t1}`);
    console.log(`  TokenID:        ${tid}`);
    console.log(`  Initialized:    ${config[5]}`);
    console.log(`  Watching:       ${config[6]}`);
    console.log(`  SubscriptionID: ${subId}`);
    console.log(`  BackupSubID:    ${backupSubId}`);
    console.log(`  STT Balance (sttBalance fn): ${formatEther(sttBal)} STT`);
    console.log(`  STT Balance (native):        ${formatEther(nativeBalance)} STT`);
    console.log(`  Tick Range:     [${config[0]}, ${config[1]}]`);
    console.log(`  Current Tick:   ${currentTick}`);
    console.log(`  Half Width:     ${config[2]}`);
    console.log(`  Tick Spacing:   ${config[3]}`);
    console.log(`  Pool Fee:       ${config[4]}`);
    
    const inRange = currentTick >= Number(config[0]) && currentTick < Number(config[1]);
    console.log(`  ▶ In Range:     ${inRange ? '✅ YES' : '❌ NO — SHOULD REBALANCE'}`);
    console.log(`  ▶ Has >= 32 STT: ${parseFloat(formatEther(nativeBalance)) >= 32 ? '✅ YES' : '❌ NO — NEEDS FUNDING'}`);
    console.log(`  ▶ Subscription Active: ${Number(subId) > 0 ? '✅ YES' : '❌ NO — CALL startWatching()'}`);
    console.log();
  }
}

diagnose().catch(e => console.error('Error:', e.message));
