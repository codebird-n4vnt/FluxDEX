import { createPublicClient, http, parseAbiItem, formatUnits, formatEther } from "viem";

const rpc = "https://dream-rpc.somnia.network";
const client = createPublicClient({ transport: http(rpc) });

const VAULT = "0x1de0bd7D3Da2Ff24B55B4Cd8Cfde24085c35C40"; // from screenshot
const BASE  = "0x96Eb871D51C51Af3BdEF5A5bf96a75812f220b68";
const WETH  = "0x9f38ec3561b2788a8D7F91745AFDF103170c9e90";
const ADMIN = "0x5DD8F8088eC3aEfd3eAC80C4655FB916856eE361";
const NPM   = "0x1B95573e9009B7dc15fC147DdB946F35A8BF5aa6";

const ERC20 = [
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function allowance(address,address) view returns (uint256)"),
];
const VAULT_ABI = [
  parseAbiItem("function tokenId() view returns (uint256)"),
  parseAbiItem("function adminFundingAddress() view returns (address)"),
];

async function check() {
  const [
    vaultBase, vaultWeth,
    adminBase, adminWeth,
    adminAllowBase, adminAllowWeth,
    tokenId, adminAddr
  ] = await Promise.all([
    client.readContract({ address: BASE, abi: ERC20, functionName: "balanceOf", args: [VAULT] }),
    client.readContract({ address: WETH, abi: ERC20, functionName: "balanceOf", args: [VAULT] }),
    client.readContract({ address: BASE, abi: ERC20, functionName: "balanceOf", args: [ADMIN] }),
    client.readContract({ address: WETH, abi: ERC20, functionName: "balanceOf", args: [ADMIN] }),
    client.readContract({ address: BASE, abi: ERC20, functionName: "allowance", args: [ADMIN, VAULT] }),
    client.readContract({ address: WETH, abi: ERC20, functionName: "allowance", args: [ADMIN, VAULT] }),
    client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "tokenId" }),
    client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "adminFundingAddress" }),
  ]);

  console.log("=== VAULT TOKEN BALANCES ===");
  console.log("Vault BASE:", formatUnits(vaultBase, 18));
  console.log("Vault WETH:", formatUnits(vaultWeth, 18));
  console.log("\n=== ADMIN BALANCES ===");
  console.log("Admin BASE:", formatUnits(adminBase, 18));
  console.log("Admin WETH:", formatUnits(adminWeth, 18));
  console.log("\n=== ADMIN → VAULT ALLOWANCES (KEY!) ===");
  console.log("Admin BASE allowance to vault:", formatUnits(adminAllowBase, 18), adminAllowBase > 0n ? "✅" : "❌ ZERO!");
  console.log("Admin WETH allowance to vault:", formatUnits(adminAllowWeth, 18), adminAllowWeth > 0n ? "✅" : "❌ ZERO!");
  console.log("\n=== VAULT STATE ===");
  console.log("tokenId in storage:", tokenId.toString(), tokenId === 0n ? "⚠️  ZERO (no active position)" : "✅");
  console.log("adminFundingAddress:", adminAddr, adminAddr !== "0x0000000000000000000000000000000000000000" ? "✅" : "❌ NOT SET");
}

check().catch(console.error);
