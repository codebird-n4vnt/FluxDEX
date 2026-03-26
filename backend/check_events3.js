import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";

const rpc = "https://dream-rpc.somnia.network";
const client = createPublicClient({ transport: http(rpc) });

const VAULT = "0xEF75Ce6Eb93db5f8f5B5392D6be02beCE4E74Bf6";
const POOL = "0xf408085B9E87321689eaA3be9aDC1D1923e47d9f";

async function checkEvents() {
    try {
        console.log(`Checking Vault state for ${VAULT}`);

        // Check the Vault's current token balances
        const baseBal = await client.readContract({
            address: "0xa9d36E713305B4d70d2D0cE4e443957e99688e0f", // BASE2
            abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
            functionName: "balanceOf",
            args: [VAULT]
        });
        
        const usdcBal = await client.readContract({
            address: "0xc832FC70e6B057208748D3412b17Ca06Ae9C347e", // USDC
            abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
            functionName: "balanceOf",
            args: [VAULT]
        });

        console.log("Vault BASE balance:", formatUnits(baseBal, 18));
        console.log("Vault USDC balance:", formatUnits(usdcBal, 18));
        
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
            console.log("Admin BASE Allowance to Vault:", formatUnits(baseAllow, 18));
            
            const usdcAllow = await client.readContract({
                address: "0xc832FC70e6B057208748D3412b17Ca06Ae9C347e",
                abi: [parseAbiItem("function allowance(address,address) view returns (uint256)")],
                functionName: "allowance",
                args: [adminAddress, VAULT]
            });
            console.log("Admin USDC Allowance to Vault:", formatUnits(usdcAllow, 18));
            
            const baseAdminBal = await client.readContract({
                address: "0xa9d36E713305B4d70d2D0cE4e443957e99688e0f",
                abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
                functionName: "balanceOf",
                args: [adminAddress]
            });
            console.log("Admin BASE Balance:", formatUnits(baseAdminBal, 18));
        }

    } catch (err) {
        console.error("Error:", err);
    }
}
checkEvents();
