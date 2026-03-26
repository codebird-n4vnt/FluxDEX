const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const RPC_URL = process.env.RPC_URL || "https://api.infra.testnet.somnia.network";
  const MY_WETH = process.env.MY_WETH;
  const MY_BASE = process.env.MY_BASE;

  if (!MY_WETH || !MY_BASE) {
    throw new Error("Missing env vars. Please set MY_WETH and MY_BASE in contracts/.env");
  }

  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  // Reduce Somnia tx rejection risk by explicitly setting reasonable fee ceilings.
  // (You can override via env if needed.)
  const PRIORITY_GWEI = process.env.PRIORITY_FEE_PER_GAS_WEI || "2000000000"; // 2 gwei
  const MAX_FEE_WEI = process.env.MAX_FEE_PER_GAS_WEI || "12000000000"; // 12 gwei
  const feeOverrides = {
    maxPriorityFeePerGas: BigInt(PRIORITY_GWEI),
    maxFeePerGas: BigInt(MAX_FEE_WEI),
  };

  // ---------------------------------------------------------------------------
  // Uniswap V3: deploy from prebuilt artifacts (no Solidity sources needed)
  // ---------------------------------------------------------------------------
  const UniswapV3FactoryArtifact = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
  const SwapRouterArtifact = require("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json");
  const NonfungiblePositionManagerArtifact = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");

  const factoryFactory = new ethers.ContractFactory(
    UniswapV3FactoryArtifact.abi,
    UniswapV3FactoryArtifact.bytecode,
    deployer
  );
  const uniswapFactory = await factoryFactory.deploy(feeOverrides);
  await uniswapFactory.waitForDeployment();
  const uniswapFactoryAddress = await uniswapFactory.getAddress();
  console.log("UniswapV3Factory:", uniswapFactoryAddress);

  const routerFactory = new ethers.ContractFactory(
    SwapRouterArtifact.abi,
    SwapRouterArtifact.bytecode,
    deployer
  );
  const router = await routerFactory.deploy(uniswapFactoryAddress, MY_WETH, feeOverrides);
  await router.waitForDeployment();
  console.log("SwapRouter:", await router.getAddress());

  // Pass tokenDescriptor = 0x0 to avoid deploying + linking descriptor libraries.
  // Minting and liquidity ops still work; tokenURI calls will fail (if ever used).
  const npmFactory = new ethers.ContractFactory(
    NonfungiblePositionManagerArtifact.abi,
    NonfungiblePositionManagerArtifact.bytecode,
    deployer
  );
  const npm = await npmFactory.deploy(uniswapFactoryAddress, MY_WETH, ZERO_ADDRESS, feeOverrides);
  await npm.waitForDeployment();
  const npmAddress = await npm.getAddress();
  console.log("NonfungiblePositionManager:", npmAddress);

  // ---------------------------------------------------------------------------
  // FluxDEX (your contracts) - compile artifacts are produced by Hardhat
  // ---------------------------------------------------------------------------
  const FluxFactory = await ethers.getContractFactory("FluxFactory");

  const fluxFactory = await FluxFactory.deploy(npmAddress, feeOverrides);
  await fluxFactory.waitForDeployment();
  const fluxFactoryAddress = await fluxFactory.getAddress();
  console.log("FluxFactory:", fluxFactoryAddress);

  const ERC20_ABI = [
    "function approve(address spender,uint256 amount) external returns (bool)",
    "function allowance(address owner,address spender) external view returns (uint256)",
  ];
  const weth = new ethers.Contract(MY_WETH, ERC20_ABI, deployer);
  const base = new ethers.Contract(MY_BASE, ERC20_ABI, deployer);

  const FEE = 3000;
  const HALF_WIDTH = 600;
  const DEPOSIT = ethers.parseEther("1");
  // sqrtPriceX96 for 1:1 ratio between two 18-decimal tokens = 2^96
  const SQRT_PRICE_1_TO_1 = BigInt("79228162514264337593543950336");

  // Vault needs >= 32 STT for reactivity subscriptions. We send 80 STT.
  const STT_FOR_VAULT = ethers.parseEther("40");

  // Approve both tokens generously (order doesn't matter because amounts are equal).
  await (await weth.approve(fluxFactoryAddress, DEPOSIT)).wait();
  await (await base.approve(fluxFactoryAddress, DEPOSIT)).wait();

  console.log("Creating pool + vault via FluxFactory.createVault()...");
  const createTx = await fluxFactory.createVault(
    MY_BASE,
    MY_WETH,
    FEE,
    SQRT_PRICE_1_TO_1,
    DEPOSIT,
    DEPOSIT,
    HALF_WIDTH,
    { value: STT_FOR_VAULT, ...feeOverrides }
  );
  const receipt = await createTx.wait();

  let vaultAddr = null;
  let poolAddr = null;
  for (const log of receipt.logs) {
    try {
      const parsed = fluxFactory.interface.parseLog(log);
      if (parsed && parsed.name === "VaultCreated") {
        poolAddr = parsed.args.pool;
        vaultAddr = parsed.args.vault;
        break;
      }
    } catch (_) {}
  }
  if (!vaultAddr || !poolAddr) throw new Error("Could not find VaultCreated event in receipt logs");
  console.log("Pool:", poolAddr);
  console.log("Vault:", vaultAddr);

  const FluxVault = await ethers.getContractFactory("FluxVault");
  const vault = await FluxVault.attach(vaultAddr);

  const GAS_SWAP_HANDLER = 6000000;
  const GAS_BACKUP_HANDLER = 6000000;

  console.log("Starting vault reactivity subscriptions...");
  await (await vault.startWatching(GAS_SWAP_HANDLER, feeOverrides)).wait();
  await (await vault.startBackupWatcher(GAS_BACKUP_HANDLER, feeOverrides)).wait();
  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
