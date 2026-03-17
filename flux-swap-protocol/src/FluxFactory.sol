// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// ════════════════════════════════════════════════════════════════════════════════
//  FLUXDEX — FluxFactory.sol
//  Permissionless factory that deploys a FluxVault for any Uniswap V3 token pair
//  on the Somnia Testnet.
//
//  What createVault() does in one transaction:
//    1.  Sort tokens             — ensures token0 < token1 (Uniswap V3 requirement)
//    2.  Resolve tick spacing    — derived from fee tier, no external call needed
//    3.  Create + init pool      — via NPM.createAndInitializePoolIfNecessary
//    4.  Deploy FluxVault        — parameterised with pool, tokens, range
//    5.  Fund vault with STT     — forwards msg.value straight to vault.receive()
//    6.  Pull tokens from caller — transferFrom(caller → vault) for both tokens
//    7.  Initialize LP position  — vault.initializeFirstPosition()
//    8.  Transfer vault ownership → caller (factory is owner only during setup)
//    9.  Register in registry    — poolAddress → vaultAddress mapping
//
//  Solidity 0.8.19 STRICT — never upgrade (PUSH0 / EIP-3855 breaks Uniswap V3).
//
//  ⚠  SOMNIA GAS NOTE
//  Deploying a new contract on Somnia costs:
//    • New account creation: 400,000 gas
//    • Bytecode: 3,125 gas/byte
//  createVault() is the most expensive call in FluxDEX. Always run with
//  --gas-estimate-multiplier 200. Budget ~10M gas for the full call.
//
//  ⚠  CALLER RESPONSIBILITIES BEFORE createVault()
//    1. Approve token0 and token1 to this factory (not the vault) for at least
//       amount0Desired and amount1Desired respectively.
//    2. Send enough msg.value (STT) to cover the vault's Reactivity subscription
//       minimum (32 STT) plus a buffer for ongoing fees. Recommended: 80 STT.
//    3. Call startWatching() and startBackupWatcher() on the returned vault
//       AFTER createVault() — those are separate transactions from the vault owner.
// ════════════════════════════════════════════════════════════════════════════════

import {FluxVault} from "./FluxVault.sol";

// ──────────────────────────────────────────────────────────────────────────────
//  INTERFACES
// ──────────────────────────────────────────────────────────────────────────────

/// @notice Minimal NPM interface — only what the factory needs.
interface INPMFactory {
    /// @notice Creates a pool if it doesn't exist and initialises its price.
    /// @dev    If the pool already exists at this price, this is a no-op.
    /// @param  token0       Lower-address token.
    /// @param  token1       Higher-address token.
    /// @param  fee          Fee tier (500, 3000, or 10000).
    /// @param  sqrtPriceX96 Initial sqrt price as a Q64.96 fixed-point number.
    /// @return pool         Address of the (possibly newly created) pool.
    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24  fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool);
}

/// @notice Minimal ERC-20 interface used by the factory.
interface IERC20Factory {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}


// ──────────────────────────────────────────────────────────────────────────────
//  FLUXFACTORY
// ──────────────────────────────────────────────────────────────────────────────

/// @title  FluxFactory
/// @notice Permissionless factory for deploying FluxVault instances on Somnia Testnet.
/// @dev    Each vault manages one Uniswap V3 pool. The factory:
///           • Creates the pool if it doesn't yet exist
///           • Deploys a FluxVault configured for that pool
///           • Seeds the vault with tokens and initialises the first LP position
///           • Transfers vault ownership to the caller
///           • Maintains a registry of pool → vault mappings
///
///         The factory is only the vault's `owner` during the setup window inside
///         `createVault`. Ownership is transferred to `msg.caller` before the
///         function returns. The factory retains no ongoing privileges over vaults.
///
///         ⚠  Somnia gas: deploying a new contract costs 400k gas for account
///         creation + 3,125 gas/byte of bytecode. createVault() should be called
///         with --gas-estimate-multiplier 200 in Foundry.
contract FluxFactory {

    // ═══════════════════════════════════════════════════════════════════════════
    //  CUSTOM ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Reverts when caller is not the factory owner.
    error NotOwner();

    /// @dev Reverts when a zero address is supplied.
    error ZeroAddress();

    /// @dev Reverts when an unsupported fee tier is supplied.
    /// @param fee The fee tier that was rejected.
    error UnsupportedFeeTier(uint24 fee);

    /// @dev Reverts when a vault already exists for this pool.
    /// @param pool  The pool address that already has a vault.
    /// @param vault The existing vault address.
    error VaultAlreadyExists(address pool, address vault);

    /// @dev Reverts when token0 >= token1 after sorting (should never happen).
    error InvalidTokenOrder();

    /// @dev Reverts when an ERC-20 transferFrom fails.
    error TokenTransferFailed();

    /// @dev Reverts when the STT funding sent is below the minimum required.
    /// @param required Minimum STT in wei (32 STT = 32e18).
    /// @param actual   msg.value received.
    error InsufficientSTTFunding(uint256 required, uint256 actual);

    /// @dev Reverts when token approval to factory is insufficient.
    /// @param token    The token with insufficient allowance.
    /// @param required Amount required.
    /// @param actual   Current allowance.
    error InsufficientAllowance(address token, uint256 required, uint256 actual);

    /// @dev Reverts when a native STT transfer fails.
    error STTTransferFailed();


    // ═══════════════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Minimum STT the vault must hold for a Reactivity subscription.
    uint256 public constant MIN_STT_FUNDING = 32 ether;


    // ═══════════════════════════════════════════════════════════════════════════
    //  STORAGE
    //
    //  Slot 0 — owner    (address)
    //  Slot 1 — npm      (address)
    //  Slot 2 — vaultCount (uint256) — total vaults deployed
    //  Slot 3+ — vaultByPool mapping
    //  Slot N  — poolByVault mapping
    //  Slot M  — vaultByIndex mapping
    // ═══════════════════════════════════════════════════════════════════════════

    // ── Slot 0 ──────────────────────────────────────────────────────────────
    /// @notice Factory owner — can update the npm address if needed.
    address public owner;

    // ── Slot 1 ──────────────────────────────────────────────────────────────
    /// @notice NonfungiblePositionManager used by all deployed vaults.
    address public npm;

    // ── Slot 2 ──────────────────────────────────────────────────────────────
    /// @notice Total number of vaults deployed by this factory.
    uint256 public vaultCount;

    // ── Mappings ─────────────────────────────────────────────────────────────
    /// @notice Returns the vault address for a given pool address.
    /// @dev    address(0) means no vault has been deployed for that pool.
    mapping(address => address) public vaultByPool;

    /// @notice Returns the pool address managed by a given vault.
    mapping(address => address) public poolByVault;

    /// @notice Returns the vault address at a given index (0-based).
    /// @dev    Useful for iterating all deployed vaults.
    mapping(uint256 => address) public vaultByIndex;


    // ═══════════════════════════════════════════════════════════════════════════
    //  EVENTS  (minimal — Somnia LOG ≈ 13× Ethereum)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when a new vault is deployed.
    /// @param pool     The Uniswap V3 pool the vault manages.
    /// @param vault    The deployed FluxVault address.
    /// @param token0   Lower-address token of the pair.
    /// @param token1   Higher-address token of the pair.
    /// @param fee      Pool fee tier.
    /// @param deployer The caller who will own the vault.
    event VaultCreated(
        address indexed pool,
        address indexed vault,
        address token0,
        address token1,
        uint24  fee,
        address indexed deployer
    );

    /// @notice Emitted when the factory owner changes.
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    /// @notice Emitted when the npm address is updated.
    event NpmUpdated(address indexed oldNpm, address indexed newNpm);


    // ═══════════════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }


    // ═══════════════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Deploys the factory.
    /// @param _npm  Address of the Uniswap V3 NonfungiblePositionManager.
    constructor(address _npm) {
        if (_npm == address(0)) revert ZeroAddress();
        owner = msg.sender;
        npm   = _npm;
    }


    // ═══════════════════════════════════════════════════════════════════════════
    //  CORE — CREATE VAULT
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Deploys a FluxVault for a given token pair and initialises it.
    /// @dev    Caller must:
    ///           1. Approve this factory for `amount0Desired` of tokenA.
    ///           2. Approve this factory for `amount1Desired` of tokenB.
    ///           3. Send msg.value ≥ 32 STT (forwarded to vault for Reactivity sub).
    ///              Recommended: 80 STT to cover ongoing fees.
    ///           4. After this call returns, call vault.startWatching() and
    ///              vault.startBackupWatcher() as the vault owner.
    ///
    ///         Token ordering is handled automatically — pass tokenA and tokenB
    ///         in any order. The factory sorts them before pool creation.
    ///
    ///         sqrtPriceX96 encodes the initial price as sqrt(token1/token0) * 2^96.
    ///         For a 1:1 price: sqrtPriceX96 = 79228162514264337593543950336 (= 2^96).
    ///         Use the helper view function `computeSqrtPriceX96` for other ratios.
    ///
    /// @param  tokenA         One token of the pair (any order).
    /// @param  tokenB         The other token of the pair (any order).
    /// @param  fee            Pool fee tier. Must be 500, 3000, or 10000.
    /// @param  sqrtPriceX96   Initial pool price as Q64.96 sqrt ratio.
    /// @param  amount0Desired Amount of token0 (sorted) to deposit.
    /// @param  amount1Desired Amount of token1 (sorted) to deposit.
    /// @param  halfWidth      Half-width of LP range in ticks.
    ///                        Must be a positive multiple of the fee tier's tick spacing.
    ///                        Recommended: 600 for 0.3% fee (±600 ticks ≈ ±6%).
    /// @return vault          Address of the deployed FluxVault.
    /// @return pool           Address of the Uniswap V3 pool.
    function createVault(
        address tokenA,
        address tokenB,
        uint24  fee,
        uint160 sqrtPriceX96,
        uint256 amount0Desired,
        uint256 amount1Desired,
        int24   halfWidth
    ) external payable returns (address vault, address pool) {

        // ── Pre-flight ────────────────────────────────────────────────────────
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
        if (msg.value < MIN_STT_FUNDING)
            revert InsufficientSTTFunding(MIN_STT_FUNDING, msg.value);

        // ── Step 1: Sort tokens ───────────────────────────────────────────────
        // Uniswap V3 requires token0 < token1 by address.
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        if (token0 >= token1) revert InvalidTokenOrder(); // should never happen

        // ── Step 2: Resolve tick spacing from fee tier ────────────────────────
        // Tick spacing is deterministic from fee — no external call needed.
        // Somnia gas: avoids a cold external call (~1M gas) to the pool/factory.
        int24 tickSpacing = _tickSpacingForFee(fee);

        // ── Step 3: Validate allowances before touching anything ──────────────
        // Fail fast before any state changes or deployments.
        {
            uint256 allow0 = IERC20Factory(token0).allowance(msg.sender, address(this));
            if (allow0 < amount0Desired)
                revert InsufficientAllowance(token0, amount0Desired, allow0);

            uint256 allow1 = IERC20Factory(token1).allowance(msg.sender, address(this));
            if (allow1 < amount1Desired)
                revert InsufficientAllowance(token1, amount1Desired, allow1);
        }

        // ── Step 4: Create + initialize pool if needed ────────────────────────
        // createAndInitializePoolIfNecessary is idempotent — safe to call even if
        // the pool already exists at this price. Returns the pool address either way.
        address _npm = npm; // cache slot 1 — used multiple times below

        pool = INPMFactory(_npm).createAndInitializePoolIfNecessary(
            token0,
            token1,
            fee,
            sqrtPriceX96
        );

        // ── Step 5: Guard — one vault per pool ────────────────────────────────
        if (vaultByPool[pool] != address(0))
            revert VaultAlreadyExists(pool, vaultByPool[pool]);

        // ── Step 6: Deploy FluxVault ──────────────────────────────────────────
        // The vault's constructor sets owner = address(this) (the factory).
        // Ownership is transferred to msg.sender at the end of this function.
        // The factory uses its temporary ownership to call initializeFirstPosition.
        //
        // Somnia gas: new contract deployment = 400k account creation + bytecode cost.
        // --gas-estimate-multiplier 200 is mandatory on the createVault() call.
        FluxVault _vault = new FluxVault(
            pool,
            _npm,
            halfWidth,
            tickSpacing,
            token0,
            token1
        );

        vault = address(_vault);

        // ── Step 7: Fund vault with STT ───────────────────────────────────────
        // Forwards the caller's msg.value to vault.receive() for the Reactivity
        // subscription minimum (32 STT) plus ongoing fee buffer.
        (bool ok,) = vault.call{value: msg.value}("");
        if (!ok) revert STTTransferFailed();

        // ── Step 8: Pull tokens from caller into vault ────────────────────────
        // The factory acts as a conduit — tokens go caller → factory → vault
        // in a single atomic sequence. The factory never holds tokens at rest.
        bool ok0 = IERC20Factory(token0).transferFrom(msg.sender, vault, amount0Desired);
        if (!ok0) revert TokenTransferFailed();

        bool ok1 = IERC20Factory(token1).transferFrom(msg.sender, vault, amount1Desired);
        if (!ok1) revert TokenTransferFailed();

        // ── Step 9: Initialize first LP position ─────────────────────────────
        // The factory is currently the vault owner so it can call this.
        // Internally the vault approves the NPM and mints the LP NFT.
        _vault.initializeFirstPosition(
            amount0Desired,
            amount1Desired,
            0, // amount0Min — no slippage guard; caller can add if desired
            0  // amount1Min
        );

        // ── Step 10: Transfer vault ownership to caller ───────────────────────
        // From this point the factory has zero control over the vault.
        // The caller must call startWatching() and startBackupWatcher() separately.
        _vault.transferOwnership(msg.sender);

        // ── Step 11: Register in factory state ───────────────────────────────
        // Three storage writes — batched at the end to keep earlier slots warm.
        uint256 index     = vaultCount;    // cache before increment
        vaultByPool[pool] = vault;
        poolByVault[vault] = pool;
        vaultByIndex[index] = vault;
        vaultCount = index + 1;

        emit VaultCreated(pool, vault, token0, token1, fee, msg.sender);
    }


    // ═══════════════════════════════════════════════════════════════════════════
    //  VIEW HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Computes sqrtPriceX96 from a human-readable price ratio.
    /// @dev    price = amount of token1 per 1 token0 (accounting for decimals).
    ///         Example: 1 USDC (6 dec) = 0.0005 WETH (18 dec)
    ///           → priceNumerator   = 5
    ///           → priceDenominator = 10000
    ///         This is a pure helper — does NOT interact with any contract.
    ///
    ///         Uses integer square root. For production use, compute off-chain
    ///         with full precision using JavaScript's BigInt or Python's Decimal.
    ///
    /// @param  priceNumerator    Numerator of the token1/token0 price ratio.
    /// @param  priceDenominator  Denominator of the token1/token0 price ratio.
    /// @return sqrtPriceX96      The Q64.96 sqrt price for pool initialization.
    function computeSqrtPriceX96(
        uint256 priceNumerator,
        uint256 priceDenominator
    ) external pure returns (uint160 sqrtPriceX96) {
        require(priceDenominator > 0, "FluxFactory: zero denominator");
        // sqrtPriceX96 = sqrt(price) * 2^96
        // = sqrt(numerator / denominator) * 2^96
        // = sqrt(numerator * 2^192 / denominator)
        uint256 ratioX192 = (priceNumerator << 192) / priceDenominator;
        sqrtPriceX96 = uint160(_sqrt(ratioX192));
    }

    /// @notice Returns the tick spacing for a given Uniswap V3 fee tier.
    /// @param  fee  Fee tier (500, 3000, or 10000).
    /// @return      Tick spacing corresponding to the fee tier.
    function tickSpacingForFee(uint24 fee) external pure returns (int24) {
        return _tickSpacingForFee(fee);
    }

    /// @notice Returns all vault addresses deployed by this factory.
    /// @dev    Iterates vaultByIndex mapping up to vaultCount.
    ///         Avoid calling on-chain for large counts — use off-chain indexing.
    /// @return vaults  Array of all deployed vault addresses.
    function getAllVaults() external view returns (address[] memory vaults) {
        uint256 count = vaultCount;
        vaults = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            vaults[i] = vaultByIndex[i];
        }
    }


    // ═══════════════════════════════════════════════════════════════════════════
    //  ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Transfers factory ownership to `newOwner`.
    /// @dev    Does NOT affect any deployed vault ownership.
    /// @param  newOwner  New factory owner. Cannot be zero.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Updates the NPM address used for future vault deployments.
    /// @dev    Does NOT affect already-deployed vaults — they store npm immutably.
    ///         Only use this if the NPM is redeployed on testnet.
    /// @param  _npm  New NPM address. Cannot be zero.
    function setNpm(address _npm) external onlyOwner {
        if (_npm == address(0)) revert ZeroAddress();
        emit NpmUpdated(npm, _npm);
        npm = _npm;
    }


    // ═══════════════════════════════════════════════════════════════════════════
    //  INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Returns the tick spacing for a Uniswap V3 fee tier.
    ///      Reverts with UnsupportedFeeTier for unknown values.
    ///      Derived from Uniswap V3 factory tickSpacingToFee mapping:
    ///        10 → 500  | 60 → 3000  | 200 → 10000
    function _tickSpacingForFee(uint24 fee) internal pure returns (int24) {
        if (fee == 500)   return 10;
        if (fee == 3000)  return 60;
        if (fee == 10000) return 200;
        revert UnsupportedFeeTier(fee);
    }

    /// @dev Integer square root using the Babylonian method.
    ///      Returns floor(sqrt(x)).
    ///      Used by computeSqrtPriceX96 for on-chain price computation.
    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
