import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";

const rpc = "https://dream-rpc.somnia.network";
const client = createPublicClient({ transport: http(rpc) });

const USER = "0x5DD8F8088eC3aEfd3eAC80C4655FB916856eE361";
const BASE = "0xa9d36E713305B4d70d2D0cE4e443957e99688e0f";
const TOKEN_B = "0xC930abB6450225b4bcB621A066D4424bC2AE1Cd3";

async function check() {
    try {
        const balBase = await client.readContract({
            address: BASE,
            abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
            functionName: "balanceOf",
            args: [USER]
        });
        console.log("User BASE balance:", formatUnits(balBase, 18));
        
        const balB = await client.readContract({
            address: TOKEN_B,
            abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
            functionName: "balanceOf",
            args: [USER]
        });
        console.log("User TokenB balance:", formatUnits(balB, 18));
    } catch (e) {
        console.error(e.message);
    }
}
check();
