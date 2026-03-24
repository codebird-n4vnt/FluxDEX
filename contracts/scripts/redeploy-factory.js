const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Redeploying FluxFactory with:", deployer.address);

  // Existing Uniswap addresses (do NOT redeploy these)
  const NPM = process.env.NONFUNGIBLE_POSITION_MANAGER;
  if (!NPM) throw new Error("NONFUNGIBLE_POSITION_MANAGER not set in .env");

  const feeOverrides = {
    maxPriorityFeePerGas: 2000000000n,
    maxFeePerGas: 12000000000n,
  };

  // Deploy new FluxFactory with updated FluxVault bytecode
  const FluxFactory = await ethers.getContractFactory("FluxFactory");
  const fluxFactory = await FluxFactory.deploy(NPM, feeOverrides);
  await fluxFactory.waitForDeployment();
  const newFactoryAddress = await fluxFactory.getAddress();

  console.log("\n════════════════════════════════════════");
  console.log("  NEW FluxFactory:", newFactoryAddress);
  console.log("════════════════════════════════════════");
  console.log("\nUpdate these files:");
  console.log("  backend/.env      → FACTORY_ADDRESS=" + newFactoryAddress);
  console.log("  contracts/.env    → FLUX_FACTORY=" + newFactoryAddress);
  console.log("  frontend/.env     → VITE_FACTORY_ADDRESS=" + newFactoryAddress);
  console.log("\nThen restart backend + frontend.");
  console.log("Create a new vault via the frontend to use the fixed FluxVault.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
