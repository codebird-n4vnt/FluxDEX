/**
 * force-rebalance.js
 * Manually simulates what the Somnia precompile does: calls onEvent on the vault.
 * This proves (or disproves) that the vault code works — if it does, the fault
 * is with the precompile delivery; if it doesn't, we see the real revert reason.
 *
 * Usage: node force-rebalance.js [vaultAddress]
 */
import { createPublicClient, createWalletClient, http, encodeFunctionData, encodeAbiParameters, parseAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import dotenv from 'dotenv';
dotenv.config();

const SOMNIA_TESTNET = { id: 50312, name: 'Somnia Testnet', nativeCurrency: { name: 'STT', symbol: 'STT', decimals: 18 }, rpcUrls: { default: { http: ['https://dream-rpc.somnia.network'] } } };

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
const PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000000100';

const VAULT_ABI = [
  { type: 'function', name: 'config', inputs: [], outputs: [
    { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' },
    { name: 'halfWidth', type: 'int24' }, { name: 'tickSpacing', type: 'int24' },
    { name: 'poolFee', type: 'uint24' }, { name: 'initialized', type: 'bool' },
    { name: 'watching', type: 'bool' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'pool', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'subscriptionId', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'tokenId', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'token0', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'token1', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'onEvent', inputs: [
    { name: 'emitter', type: 'address' },
    { name: 'eventTopics', type: 'bytes32[]' },
    { name: 'data', type: 'bytes' },
  ], outputs: [], stateMutability: 'nonpayable' },
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

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const publicClient = createPublicClient({ chain: SOMNIA_TESTNET, transport: http() });
const walletClient = createWalletClient({ account, chain: SOMNIA_TESTNET, transport: http() });

async function main() {
  console.log('═══ FluxDEX Force Rebalance Tool ═══\n');
  console.log('Using account:', account.address);
  if (!FACTORY_ADDRESS) throw new Error('FACTORY_ADDRESS not set in .env');

  // Get vault to operate on
  const vaults = await publicClient.readContract({ address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'getAllVaults' });
  
  let targetVault = process.argv[2];
  if (!targetVault) {
    console.log(`Factory has ${vaults.length} vault(s). Using the latest one.`);
    targetVault = vaults[vaults.length - 1];
  }
  console.log(`\nTarget vault: ${targetVault}\n`);

  // Read vault state
  const [config, poolAddr, subId, tid, t0, t1] = await Promise.all([
    publicClient.readContract({ address: targetVault, abi: VAULT_ABI, functionName: 'config' }),
    publicClient.readContract({ address: targetVault, abi: VAULT_ABI, functionName: 'pool' }),
    publicClient.readContract({ address: targetVault, abi: VAULT_ABI, functionName: 'subscriptionId' }),
    publicClient.readContract({ address: targetVault, abi: VAULT_ABI, functionName: 'tokenId' }),
    publicClient.readContract({ address: targetVault, abi: VAULT_ABI, functionName: 'token0' }),
    publicClient.readContract({ address: targetVault, abi: VAULT_ABI, functionName: 'token1' }),
  ]);

  const slot0 = await publicClient.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'slot0' });
  const currentTick = Number(slot0[1]);
  const tickLower = Number(config[0]);
  const tickUpper = Number(config[1]);
  const inRange = currentTick >= tickLower && currentTick < tickUpper;

  console.log('── Vault State ─────────────────────────────────');
  console.log(`  Pool:          ${poolAddr}`);
  console.log(`  Token0:        ${t0}`);
  console.log(`  Token1:        ${t1}`);
  console.log(`  TokenID:       ${tid}`);
  console.log(`  SubscriptionID: ${subId}`);
  console.log(`  Tick Range:    [${tickLower}, ${tickUpper}]`);
  console.log(`  Current Tick:  ${currentTick}`);
  console.log(`  In Range:      ${inRange ? '✅ YES' : '❌ NO — rebalance needed'}`);
  console.log(`  Initialized:   ${config[5]}`);
  console.log(`  Watching:      ${config[6]}`);
  console.log();

  if (inRange) {
    console.log('✅ Pool is in range — no rebalance needed.');
    return;
  }

  if (Number(subId) === 0) {
    console.log('❌ Subscription ID is 0 — vault is not watching. Call startWatching() first.');
    return;
  }

  // Build a fake Swap event payload with the current pool tick
  // Swap event: (int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
  const fakeSwapData = encodeAbiParameters(
    parseAbiParameters('int256, int256, uint160, uint128, int24'),
    [1000000n, -900000n, slot0[0], 1000000000000000000n, BigInt(currentTick)]
  );

  const fakeTopics = [SWAP_TOPIC, '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)];

  console.log('── Simulating onEvent call ──────────────────────');
  console.log('  Emitter (pool):', poolAddr);
  console.log('  Fake tick:     ', currentTick);
  console.log();

  // First simulate to see if it would revert
  try {
    await publicClient.simulateContract({
      address: targetVault,
      abi: VAULT_ABI,
      functionName: 'onEvent',
      args: [poolAddr, fakeTopics, fakeSwapData],
      account: PRECOMPILE_ADDRESS, // simulate as if called by precompile
    });
    console.log('✅ Simulation PASSED — onEvent would succeed if called by precompile');
    console.log('   → The vault logic is correct. The Somnia precompile is not delivering events.');
  } catch (err) {
    console.log('❌ Simulation FAILED — onEvent would REVERT:');
    console.log('  Reason:', err.message?.slice(0, 500));
    console.log();
    console.log('   → This is the bug. The precompile CAN call onEvent but it reverts silently.');
    return;
  }

  console.log();
  console.log('── Attempting to call onEvent directly ──────────');
  console.log('  NOTE: This will revert because `onlyPrecompile` requires caller = 0x...0100');
  console.log('  But we learn from the revert message what WOULD have happened.\n');

  // Now actually send (will likely fail due to onlyPrecompile guard)
  try {
    // Try calling via gas estimation to get better error message
    const gas = await publicClient.estimateContractGas({
      address: targetVault,
      abi: VAULT_ABI,
      functionName: 'onEvent',
      args: [poolAddr, fakeTopics, fakeSwapData],
      account: account.address,
    });
    
    // If gas estimation passes (shouldn't because of onlyPrecompile), try sending
    console.log('Gas estimate:', gas.toString());
    const txHash = await walletClient.writeContract({
      address: targetVault,
      abi: VAULT_ABI,
      functionName: 'onEvent',
      args: [poolAddr, fakeTopics, fakeSwapData],
      gas: gas * 2n,
    });
    console.log('Tx Hash:', txHash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log('Status:', receipt.status);
  } catch (err) {
    console.log('Expected revert (onlyPrecompile):', err.message?.slice(0, 300));
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
