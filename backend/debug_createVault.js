import "dotenv/config";
import { createPublicClient, http, parseAbi, parseEther, parseUnits, encodeFunctionData, decodeFunctionResult } from "viem";

const RPC = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const FACTORY = "0x48c91160D6A5e4690fb71C2157d51f152c7cb657";
const USER = "0x5DD8F8088eC3aEfd3eAC80C4655FB916856eE361";

// New tokens
const TOKEN_A = "0xa9d36E713305B4d70d2D0cE4e443957e99688e0f"; // BASE2
const TOKEN_B = "0xC930abB6450225b4bcB621A066D4424bC2AE1Cd3"; // WETH2

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const FACTORY_ABI = parseAbi([
  "function createVault(address,address,uint24,uint160,uint256,uint256,int24) payable returns (address,address)",
  "function computeSqrtPriceX96(uint256,uint256) pure returns (uint160)",
  "function vaultByPool(address) view returns (address)",
]);

const NPM_ABI = parseAbi([
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)",
]);

const UNIV3_FACTORY_ABI = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
]);

const client = createPublicClient({
  transport: http(RPC),
  chain: { id: 50312, name: "Somnia Testnet" },
});

async function main() {
  console.log("=== FluxDEX createVault Debug ===\n");

  // Sort tokens
  const sorted = TOKEN_A.toLowerCase() < TOKEN_B.toLowerCase();
  const token0 = sorted ? TOKEN_A : TOKEN_B;
  const token1 = sorted ? TOKEN_B : TOKEN_A;
  console.log(`token0: ${token0}`);
  console.log(`token1: ${token1}`);
  console.log(`sorted (A<B): ${sorted}\n`);

  // 1. Check token details
  for (const [label, addr] of [["token0", token0], ["token1", token1]]) {
    try {
      const [sym, dec, bal, allow] = await Promise.all([
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }),
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" }),
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: "balanceOf", args: [USER] }),
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: "allowance", args: [USER, FACTORY] }),
      ]);
      console.log(`${label} (${sym}): decimals=${dec} balance=${bal} allowance=${allow}`);
    } catch (e) {
      console.error(`Error reading ${label}:`, e.message?.slice(0, 100));
    }
  }
  console.log();

  // 2. Check sqrtPriceX96
  try {
    const sqrtPrice = await client.readContract({
      address: FACTORY, abi: FACTORY_ABI,
      functionName: "computeSqrtPriceX96",
      args: [10n ** 18n, 10n ** 18n],
    });
    console.log(`sqrtPriceX96 (1:1) = ${sqrtPrice}`);
  } catch (e) {
    console.error("sqrtPriceX96 error:", e.message?.slice(0, 100));
  }

  // 3. Check if pool already exists
  const UNIV3_FACTORY = "0x8Fa7B7147402986451931653fB511D05c9fdaaf8";
  try {
    const pool = await client.readContract({
      address: UNIV3_FACTORY, abi: UNIV3_FACTORY_ABI,
      functionName: "getPool", args: [token0, token1, 3000],
    });
    console.log(`\nExisting pool (0.3%): ${pool}`);
    if (pool !== "0x0000000000000000000000000000000000000000") {
      // Check if vault already exists for this pool
      const vault = await client.readContract({
        address: FACTORY, abi: FACTORY_ABI,
        functionName: "vaultByPool", args: [pool],
      });
      console.log(`Vault for this pool: ${vault}`);
      if (vault !== "0x0000000000000000000000000000000000000000") {
        console.log("\n⚠️  VAULT ALREADY EXISTS! This is why createVault reverts.");
      }
    }
  } catch (e) {
    console.error("Pool check error:", e.message?.slice(0, 100));
  }

  // 4. Simulate createVault
  console.log("\n=== Simulating createVault ===");
  try {
    const sqrtPrice = await client.readContract({
      address: FACTORY, abi: FACTORY_ABI,
      functionName: "computeSqrtPriceX96",
      args: [10n ** 18n, 10n ** 18n],
    });

    await client.simulateContract({
      address: FACTORY,
      abi: FACTORY_ABI,
      functionName: "createVault",
      args: [token0, token1, 3000, sqrtPrice, parseUnits("1", 18), parseUnits("1", 18), 600],
      value: parseEther("40"),
      account: USER,
    });
    console.log("✅ Simulation succeeded!");
  } catch (e) {
    console.log("❌ Simulation FAILED:", e.message?.slice(0, 500));
  }
}

main().catch(e => console.error("Fatal:", e.message?.slice(0, 300)));
