const { ethers } = require("hardhat");

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Executing Whale Swap with Wallet:", signer.address);

  // --- EXACT ADDRESSES ---
  const SWAP_ROUTER = "0x4d236EE0EAD55a020113Be7DB6e182F66e5C4921"; 
  const MY_WETH = "0x9f38ec3561b2788a8D7F91745AFDF103170c9e90";
  const MY_BASE = "0x96Eb871D51C51Af3BdEF5A5bf96a75812f220b68";

  // --- INLINE ABIs ---
  const erc20Abi = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function balanceOf(address account) view returns (uint256)"
  ];

  // FIX: Converted the custom struct into a raw tuple so ethers.js can parse it
  const routerAbi = [
    "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)"
  ];

  const weth = new ethers.Contract(MY_WETH, erc20Abi, signer);
  const router = new ethers.Contract(SWAP_ROUTER, routerAbi, signer);

  // Check how much WETH you actually have
  const myBalance = await weth.balanceOf(signer.address);
  console.log(`Your current MY_WETH balance: ${ethers.formatUnits(myBalance, 18)}`);

  const swapAmount = ethers.parseUnits("50000", 18);

  if (myBalance < swapAmount) {
      console.error("❌ You do not have enough MY_WETH to execute the Whale Swap! Go mint more on your MockERC20 contract.");
      return;
  }

  console.log("\n1. Approving SwapRouter to spend WETH...");
  const approveTx = await weth.approve(SWAP_ROUTER, swapAmount);
  await approveTx.wait();
  console.log("✅ Approved!");

  console.log("2. Executing Massive Swap to crash the pool price...");
  const params = {
    tokenIn: MY_WETH,
    tokenOut: MY_BASE,
    fee: 3000,
    recipient: signer.address,
    deadline: Math.floor(Date.now() / 1000) + 60 * 10, // 10 minutes from now
    amountIn: swapAmount,
    amountOutMinimum: 0, // No slippage protection; we WANT maximum price impact!
    sqrtPriceLimitX96: 0
  };

  // Using a high gas limit just to ensure the swap routes cleanly
  const swapTx = await router.exactInputSingle(params, { gasLimit: 3000000 });
  console.log(`Swap submitted! Hash: ${swapTx.hash}`);
  await swapTx.wait();
  console.log("✅ Swap confirmed in block!");

  console.log("\n🎯 WHALE SWAP COMPLETE!");
  console.log("Somnia Reactivity should detect the Swap event and trigger your Vault in the subsequent block.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});