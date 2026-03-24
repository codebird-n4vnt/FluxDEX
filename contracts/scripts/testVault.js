const { ethers } = require("hardhat");

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Testing with Wallet Address:", signer.address);

  // --- YOUR EXACT ADDRESSES ---
  const VAULT_ADDRESS = "0x84A4121bcCd047251f2c1f4f3a287207ec7505b8";
  const POOL_ADDRESS = "0x8fE541bda5C757106Eedac1B783022BfE85730a2";
  const NPM_ADDRESS = "0x41Bb81f9f6E967C89Ee822fd26A03d629E58A1C0";
  const MY_WETH = "0x9f38ec3561b2788a8D7F91745AFDF103170c9e90";
  const MY_BASE = "0x96Eb871D51C51Af3BdEF5A5bf96a75812f220b68";

  // --- INLINE ABIs ---
  const vaultAbi = [
    "function owner() view returns (address)",
    "function tokenId() view returns (uint256)",
    "function sttBalance() view returns (uint256)",
    "function config() view returns (int24 tickLower, int24 tickUpper, int24 halfWidth, int24 tickSpacing, uint24 poolFee, bool initialized, bool watching)"
  ];
  const poolAbi = [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
  ];
  const npmAbi = [
    "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)"
  ];
  const erc20Abi = [
    "function balanceOf(address account) view returns (uint256)"
  ];

  // --- INSTANTIATE CONTRACTS ---
  const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, signer);
  const pool = new ethers.Contract(POOL_ADDRESS, poolAbi, signer);
  const npm = new ethers.Contract(NPM_ADDRESS, npmAbi, signer);
  const weth = new ethers.Contract(MY_WETH, erc20Abi, signer);
  const base = new ethers.Contract(MY_BASE, erc20Abi, signer);

  console.log("\n=================================");
  console.log(" FLUXDEX V2: HEALTH CHECKS");
  console.log("=================================");

  const owner = await vault.owner();
  console.log(`1. Vault Owner: ${owner}`);

  const slot0 = await pool.slot0();
  console.log(`2. Current Pool Tick: ${slot0.tick}`);

  const vaultConfig = await vault.config();
  console.log(`3. Vault Active Range: [${vaultConfig.tickLower} to ${vaultConfig.tickUpper}]`);

  const tokenId = await vault.tokenId();
  console.log(`4. Current LP Token ID: ${tokenId}`);
  
  if (tokenId > 0n) {
    const positionData = await npm.positions(tokenId);
    console.log(`   Current Liquidity: ${positionData.liquidity}`);
  }

  // Use the Somnia high-gas-limit override for cold reads
  const somniaReadGas = { gasLimit: 2000000 };
  
  const etherBalance = await vault.sttBalance(somniaReadGas);
  const wethBalance = await weth.balanceOf(VAULT_ADDRESS, somniaReadGas);
  const baseBalance = await base.balanceOf(VAULT_ADDRESS, somniaReadGas);
  
  console.log(`\n5. Vault Balances:`);
  console.log(`   - Native STT: ${ethers.formatEther(etherBalance)} STT`);
  console.log(`   - MY_WETH: ${ethers.formatUnits(wethBalance, 18)}`);
  console.log(`   - MY_BASE: ${ethers.formatUnits(baseBalance, 18)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});