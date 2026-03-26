import { createPublicClient, http, parseAbiItem } from "viem";

const rpc = "https://dream-rpc.somnia.network";
const client = createPublicClient({ transport: http(rpc) });

const VAULT = "0xEF75Ce6Eb93db5f8f5B5392D6be02beCE4E74Bf6";
const POOL = "0xf408085B9E87321689eaA3be9aDC1D1923e47d9f";

async function checkEvents() {
    try {
        const latest = await client.getBlockNumber();
        const start = latest > 5000n ? latest - 5000n : 0n; // look back 5000 blocks
        console.log(`Checking events from ${start} to ${latest}`);

        // Check Rebalanced
        const rebalances = await client.getLogs({
            address: VAULT,
            event: parseAbiItem("event Rebalanced(int24 newTick, uint256 oldTokenId, uint256 newTokenId)"),
            fromBlock: start,
            toBlock: latest
        });
        console.log("Rebalanced Events:", rebalances.length);

        // Check the Vault's current token balances
        const baseBal = await client.readContract({
            address: "0xa9d36E713305B4d70d2D0cE4e443957e99688e0f", // BASE2
            abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
            functionName: "balanceOf",
            args: [VAULT]
        });
        console.log("Vault BASE balance:", baseBal);
        
        // Also check admin allowance for VAULT
        const adminAddress = await client.readContract({
            address: VAULT,
            abi: [parseAbiItem("function adminFundingAddress() view returns (address)")],
            functionName: "adminFundingAddress",
        });
        console.log("Admin Address:", adminAddress);
        
        if (adminAddress && adminAddress !== "0x0000000000000000000000000000000000000000") {
            const baseAllow = await client.readContract({
                address: "0xa9d36E713305B4d70d2D0cE4e443957e99688e0f",
                abi: [parseAbiItem("function allowance(address,address) view returns (uint256)")],
                functionName: "allowance",
                args: [adminAddress, VAULT]
            });
            console.log("Base Allowance:", baseAllow);
        }

    } catch (err) {
        console.error("Error:", err);
    }
}
checkEvents();
