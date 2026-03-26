/**
 * simulate-on-event.js
 * Simulates calling onEvent from the precompile address (0x...0100) to check if the vault rebalance works.
 */
import { createPublicClient, http, encodeAbiParameters, parseAbiParameters } from 'viem';
import dotenv from 'dotenv';
dotenv.config();

const SOMNIA = { id: 50312, name: 'Somnia', nativeCurrency: { name: 'STT', symbol: 'STT', decimals: 18 }, rpcUrls: { default: { http: ['https://dream-rpc.somnia.network'] } } };
const PRECOMPILE = '0x0000000000000000000000000000000000000100'; // Correct Somnia precompile address
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

const VAULT_ABI = [
  { type: 'function', name: 'config', inputs: [], outputs: [
    { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' },
    { name: 'halfWidth', type: 'int24' }, { name: 'tickSpacing', type: 'int24' },
    { name: 'poolFee', type: 'uint24' }, { name: 'initialized', type: 'bool' },
    { name: 'watching', type: 'bool' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'pool', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'tokenId', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
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

const client = createPublicClient({ chain: SOMNIA, transport: http() });
const FACTORY = process.env.FACTORY_ADDRESS;

async function simulate(vaultAddr) {
  console.log(`\n── Simulating vault: ${vaultAddr} ──`);
  
  const [config, poolAddr, tid] = await Promise.all([
    client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'config' }),
    client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'pool' }),
    client.readContract({ address: vaultAddr, abi: VAULT_ABI, functionName: 'tokenId' }),
  ]);

  const slot0 = await client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'slot0' });
  const currentTick = Number(slot0[1]);
  const sqrtPriceX96 = slot0[0];

  console.log(`  Current tick: ${currentTick}, Range: [${config[0]}, ${config[1]}]`);
  console.log(`  halfWidth: ${config[2]}, tickSpacing: ${config[3]}`);
  
  const inRange = currentTick >= Number(config[0]) && currentTick < Number(config[1]);
  if (inRange) {
    console.log('  ✅ In range — no rebalance needed');
    return;
  }
  
  console.log('  ❌ Out of range — simulating onEvent...');

  // Build fake swap ABI: (int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
  const fakeData = encodeAbiParameters(
    parseAbiParameters('int256, int256, uint160, uint128, int24'),
    [1000000n, -1000000n, sqrtPriceX96, 1000000000000000000n, BigInt(currentTick)]
  );

  const fakeTopics = [
    SWAP_TOPIC,
    '0x' + '0'.repeat(64),
    '0x' + '0'.repeat(64),
  ];

  try {
    const { result } = await client.simulateContract({
      address: vaultAddr,
      abi: VAULT_ABI,
      functionName: 'onEvent',
      args: [poolAddr, fakeTopics, fakeData],
      account: PRECOMPILE,
    });
    console.log('  ✅ onEvent simulation PASSED — vault code works!');
    console.log('  → The Somnia precompile is NOT delivering events to this vault.');
    console.log('  → This is a precompile delivery issue, not a vault code issue.');
    console.log('  → Possible causes:');
    console.log('    1. The pool swap topic used does not match the subscription topic.');
    console.log('    2. The precompile has a delay or bug in testnet.');
    console.log('    3. The pool contract address used in the subscription differs.');
  } catch (err) {
    console.log('  ❌ onEvent simulation FAILED:');
    const msg = err.message || '';
    // Extract the revert reason
    if (msg.includes('revert')) {
      const match = msg.match(/revert[^:]*: ([^\n]+)/i);
      console.log('  Revert reason:', match ? match[1] : msg.slice(0, 400));
    } else {
      console.log('  Error:', msg.slice(0, 400));
    }
    console.log('\n  ─ Full error details:');
    try {
      const details = JSON.stringify(err, null, 2).slice(0, 800);
      console.log(' ', details);
    } catch {}
  }
}

async function main() {
  console.log('═══ FluxDEX onEvent Simulation ═══');
  if (!FACTORY) throw new Error('FACTORY_ADDRESS not set in .env');
  const vaults = await client.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getAllVaults' });
  console.log(`Factory: ${FACTORY}\nVaults: ${vaults.length}`);

  for (const vault of vaults) {
    await simulate(vault);
  }
  console.log('\nDone.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
