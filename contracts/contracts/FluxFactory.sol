// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {FluxVault} from "./FluxVault.sol";

interface INPMFactory {
    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool);
}

interface IERC20Factory {
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
    function allowance(
        address owner,
        address spender
    ) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

contract FluxFactory {
    error NotOwner();
    error ZeroAddress();

    error UnsupportedFeeTier(uint24 fee);

    error VaultAlreadyExists(address pool, address vault);

    error InvalidTokenOrder();

    error TokenTransferFailed();

    error InsufficientSTTFunding(uint256 required, uint256 actual);

    error InsufficientAllowance(
        address token,
        uint256 required,
        uint256 actual
    );

    error STTTransferFailed();

    uint256 public constant MIN_STT_FUNDING = 32 ether;

    //  STORAGE    //
    //  Slot 0 — owner    (address)
    //  Slot 1 — npm      (address)
    //  Slot 2 — vaultCount (uint256) — total vaults deployed
    //  Slot 3+ — vaultByPool mapping
    //  Slot N  — poolByVault mapping
    //  Slot M  — vaultByIndex mapping

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
        uint24 fee,
        address indexed deployer
    );

    /// @notice Emitted when the factory owner changes.
    event OwnershipTransferred(
        address indexed oldOwner,
        address indexed newOwner
    );

    /// @notice Emitted when the npm address is updated.
    event NpmUpdated(address indexed oldNpm, address indexed newNpm);

    // ═══════════════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }
    function _onlyOwner() internal {
        if (msg.sender != owner) revert NotOwner();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Deploys the factory.
    /// @param _npm  Address of the Uniswap V3 NonfungiblePositionManager.
    constructor(address _npm) {
        if (_npm == address(0)) revert ZeroAddress();
        owner = msg.sender;
        npm = _npm;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  CORE — CREATE VAULT
    // ═══════════════════════════════════════════════════════════════════════════

    function createVault(
        address tokenA,
        address tokenB,
        uint24 fee,
        uint160 sqrtPriceX96,
        uint256 amount0Desired,
        uint256 amount1Desired,
        int24 halfWidth
    ) external payable returns (address vault, address pool) {
        // ── Pre-flight ────────────────────────────────────────────────────────
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
        if (msg.value < MIN_STT_FUNDING)
            revert InsufficientSTTFunding(MIN_STT_FUNDING, msg.value);

        // ── Step 1: Sort tokens ───────────────────────────────────────────────
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        if (token0 >= token1) revert InvalidTokenOrder();

        // ── Step 2: Resolve tick spacing from fee tier ────────────────────────
        // Somnia gas: avoids a cold external call (~1M gas) to the pool/factory.
        int24 tickSpacing = _tickSpacingForFee(fee);

        // ── Step 3: Validate allowances before touching anything ──────────────
        {
            uint256 allow0 = IERC20Factory(token0).allowance(
                msg.sender,
                address(this)
            );
            if (allow0 < amount0Desired)
                revert InsufficientAllowance(token0, amount0Desired, allow0);

            uint256 allow1 = IERC20Factory(token1).allowance(
                msg.sender,
                address(this)
            );
            if (allow1 < amount1Desired)
                revert InsufficientAllowance(token1, amount1Desired, allow1);
        }

        {
            // ── Step 4: Create + initialize pool if needed ────────────────────
            address npm_ = npm; // cache slot 1 — used multiple times below

            pool = INPMFactory(npm_).createAndInitializePoolIfNecessary(
                token0,
                token1,
                fee,
                sqrtPriceX96
            );

            // ── Step 5: Guard — one vault per pool ────────────────────────────
            if (vaultByPool[pool] != address(0))
                revert VaultAlreadyExists(pool, vaultByPool[pool]);

            // ── Step 6: Deploy FluxVault ──────────────────────────────────────
            // Somnia gas: new contract deployment = 400k account creation + bytecode cost.
            // --gas-estimate-multiplier 200 is mandatory on the createVault() call.
            FluxVault vaultContract = new FluxVault(
                pool,
                npm_,
                halfWidth,
                tickSpacing,
                token0,
                token1
            );
            vault = address(vaultContract);

            // ── Step 7: Fund vault with STT ───────────────────────────────────
            {
                (bool ok, ) = vault.call{value: msg.value}("");
                if (!ok) revert STTTransferFailed();
            }

            // ── Step 8: Pull tokens from caller into vault ────────────────────
            {
                bool ok0 = IERC20Factory(token0).transferFrom(
                    msg.sender,
                    vault,
                    amount0Desired
                );
                if (!ok0) revert TokenTransferFailed();

                bool ok1 = IERC20Factory(token1).transferFrom(
                    msg.sender,
                    vault,
                    amount1Desired
                );
                if (!ok1) revert TokenTransferFailed();
            }

            // ── Step 9: Initialize first LP position ─────────────────────────
            vaultContract.initializeFirstPosition(
                amount0Desired,
                amount1Desired,
                0, // amount0Min — no slippage guard; caller can add if desired
                0 // amount1Min
            );

            // Auto-set admin funding address to vault deployer.
            // Deployer must approve both tokens to the vault for autonomous rebalancing.
            // NOTE: startBackupWatcher must be called separately from the vault owner
            // (top-level tx) after creation — nested precompile calls revert in simulation.
            vaultContract.setAdminFundingAddress(msg.sender);

            // ── Step 10: Transfer vault ownership to caller ───────────────────
            vaultContract.transferOwnership(msg.sender);

            // ── Step 11: Register in factory state ───────────────────────────
            {
                uint256 index = vaultCount; // cache before increment
                vaultByPool[pool] = vault;
                poolByVault[vault] = pool;
                vaultByIndex[index] = vault;
                vaultCount = index + 1;
            }
        }

        emit VaultCreated(pool, vault, token0, token1, fee, msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  VIEW HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

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

    function tickSpacingForFee(uint24 fee) external pure returns (int24) {
        return _tickSpacingForFee(fee);
    }

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
        if (fee == 500) return 10;
        if (fee == 3000) return 60;
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
