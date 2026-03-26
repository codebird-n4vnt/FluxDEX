import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, usePublicClient } from 'wagmi'
import { parseEther, parseUnits, decodeEventLog, getAddress, isAddress } from 'viem'
import toast from 'react-hot-toast'
import GlassCard from '../components/ui/GlassCard'
import { FACTORY_ABI, ERC20_ABI } from '../lib/abis'
import { ArrowLeft, Coins, Zap, CheckCircle, ExternalLink, Loader2, AlertTriangle } from 'lucide-react'

const FACTORY_ADDRESS = (import.meta.env.VITE_FACTORY_ADDRESS ?? '') as `0x${string}`
const UNISWAP_V3_FACTORY_ADDRESS = (import.meta.env.VITE_UNISWAP_V3_FACTORY_ADDRESS ?? '0x8Fa7B7147402986451931653fB511D05c9fdaaf8') as `0x${string}`
const EXPLORER_URL = 'https://shannon-explorer.somnia.network'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const UNISWAP_V3_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
    stateMutability: 'view',
  },
] as const

const FEE_TIERS = [
  { value: 500, label: '0.05%', tickSpacing: 10, description: 'Best for stables' },
  { value: 3000, label: '0.30%', tickSpacing: 60, description: 'Most common' },
  { value: 10000, label: '1.00%', tickSpacing: 200, description: 'Exotic pairs' },
]

type Step = 'form' | 'approve0' | 'approve1' | 'create' | 'success'

export default function CreateVaultPage() {
  const navigate = useNavigate()
  const { isConnected, address } = useAccount()
  const publicClient = usePublicClient()

  // Form state
  const [tokenA, setTokenA] = useState('')
  const [tokenB, setTokenB] = useState('')
  const [feeTier, setFeeTier] = useState(3000)
  const [priceRatio, setPriceRatio] = useState('1')
  const [amount0, setAmount0] = useState('1')
  const [amount1, setAmount1] = useState('1')
  const [halfWidth, setHalfWidth] = useState('600')
  const [sttAmount, setSttAmount] = useState('80')
  const [step, setStep] = useState<Step>('form')

  // Result state
  const [resultVault, setResultVault] = useState('')
  const [resultPool, setResultPool] = useState('')

  // Read token symbols for display
  const { data: token0Symbol } = useReadContract({
    address: tokenA as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'symbol',
    query: { enabled: tokenA.length === 42 },
  })
  const { data: token1Symbol } = useReadContract({
    address: tokenB as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'symbol',
    query: { enabled: tokenB.length === 42 },
  })

  // Token decimals
  const { data: token0Decimals } = useReadContract({
    address: tokenA as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'decimals',
    query: { enabled: tokenA.length === 42 },
  })
  const { data: token1Decimals } = useReadContract({
    address: tokenB as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'decimals',
    query: { enabled: tokenB.length === 42 },
  })

  // On-chain allowance reads — more reliable than ephemeral UI state (resets on refresh)
  const isAValid = tokenA && isAddress(tokenA)
  const isBValid = tokenB && isAddress(tokenB)
  const t0 = isAValid && isBValid ? (tokenA.toLowerCase() < tokenB.toLowerCase() ? getAddress(tokenA) : getAddress(tokenB)) : undefined
  const t1 = isAValid && isBValid ? (tokenA.toLowerCase() < tokenB.toLowerCase() ? getAddress(tokenB) : getAddress(tokenA)) : undefined

  const { data: factoryAllowance0Raw, refetch: refetchAllow0 } = useReadContract({
    address: t0,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address && t0 ? [address, FACTORY_ADDRESS] : undefined,
    query: { enabled: !!t0 && !!address, refetchInterval: 3000 },
  })
  const { data: factoryAllowance1Raw, refetch: refetchAllow1 } = useReadContract({
    address: t1,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address && t1 ? [address, FACTORY_ADDRESS] : undefined,
    query: { enabled: !!t1 && !!address, refetchInterval: 3000 },
  })
  const isToken0Approved = factoryAllowance0Raw != null && (factoryAllowance0Raw as bigint) > 0n
  const isToken1Approved = factoryAllowance1Raw != null && (factoryAllowance1Raw as bigint) > 0n

  // Write contract hooks
  const { writeContract: approve0, data: approve0Hash } = useWriteContract()
  const { writeContract: approve1, data: approve1Hash } = useWriteContract()
  const { writeContract: createVault, data: createVaultHash } = useWriteContract()

  const { isLoading: isApprove0Loading, isSuccess: isApprove0Success } = useWaitForTransactionReceipt({ hash: approve0Hash })
  const { isLoading: isApprove1Loading, isSuccess: isApprove1Success } = useWaitForTransactionReceipt({ hash: approve1Hash })
  const { isLoading: isCreateLoading, isSuccess: isCreateSuccess, data: createReceipt } = useWaitForTransactionReceipt({ hash: createVaultHash })

  // Sort tokens (Uniswap requires token0 < token1)
  const getSortedTokens = useCallback((): { token0: string; token1: string; amount0: string; amount1: string; invertPrice: boolean } => {
    if (!tokenA || !tokenB) return { token0: '', token1: '', amount0: '0', amount1: '0', invertPrice: false }
    if (tokenA.toLowerCase() < tokenB.toLowerCase()) {
      return { token0: tokenA, token1: tokenB, amount0, amount1, invertPrice: false }
    } else {
      return { token0: tokenB, token1: tokenA, amount0: amount1, amount1: amount0, invertPrice: true }
    }
  }, [tokenA, tokenB, amount0, amount1])




  const handleApprove0 = () => {
    const sorted = getSortedTokens()
    if (!sorted.token0) return

    setStep('approve0')
    approve0({
      address: getAddress(sorted.token0),
      abi: ERC20_ABI,
      functionName: 'approve',
      // Unlimited approval — standard DeFi pattern (prevents InsufficientAllowance if user changes amounts)
      args: [FACTORY_ADDRESS, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')],
    }, {
      onSuccess: () => { toast.success(`Approve transaction submitted`); },
      onError: (err) => { toast.error(`Approval failed: ${err.message.slice(0, 80)}`); setStep('form') },
    })
  }

  const handleApprove1 = () => {
    const sorted = getSortedTokens()
    if (!sorted.token1) return

    setStep('approve1')
    approve1({
      address: getAddress(sorted.token1),
      abi: ERC20_ABI,
      functionName: 'approve',
      // Unlimited approval — standard DeFi pattern
      args: [FACTORY_ADDRESS, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')],
    }, {
      onSuccess: () => { toast.success(`Approve transaction submitted`); },
      onError: (err) => { toast.error(`Approval failed: ${err.message.slice(0, 80)}`); setStep('form') },
    })
  }

  // React to successful receipts
  useEffect(() => {
    if (isApprove0Success) {
      toast.success('Token 0 approved on-chain ✅')
      refetchAllow0()
    }
  }, [isApprove0Success, refetchAllow0])

  useEffect(() => {
    if (isApprove1Success) {
      toast.success('Token 1 approved on-chain ✅')
      refetchAllow1()
    }
  }, [isApprove1Success, refetchAllow1])

  // CRITICAL FIX: Reset step + refetch allowances when user changes token addresses.
  // This prevents the "already approved" glitch when switching to a new token pair
  // that was never approved, but old allowance data was cached from a different pair.
  useEffect(() => {
    setStep('form')
    refetchAllow0()
    refetchAllow1()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenA, tokenB])

  const handleCreateVault = async () => {
    const sorted = getSortedTokens()
    const dec0 = sorted.token0.toLowerCase() === tokenA.toLowerCase() ? (token0Decimals ?? 18) : (token1Decimals ?? 18)
    const dec1 = sorted.token1.toLowerCase() === tokenB.toLowerCase() ? (token1Decimals ?? 18) : (token0Decimals ?? 18)

    // ── Compute sqrtPriceX96 ON-CHAIN (proven to work in simulation) ─────
    try {
      const existingPool = await publicClient!.readContract({
        address: UNISWAP_V3_FACTORY_ADDRESS,
        abi: UNISWAP_V3_FACTORY_ABI,
        functionName: 'getPool',
        args: [sorted.token0 as `0x${string}`, sorted.token1 as `0x${string}`, feeTier],
      }) as `0x${string}`

      if (existingPool && existingPool.toLowerCase() !== ZERO_ADDRESS) {
        const existingVault = await publicClient!.readContract({
          address: FACTORY_ADDRESS,
          abi: FACTORY_ABI,
          functionName: 'vaultByPool',
          args: [existingPool],
        }) as `0x${string}`

        if (existingVault && existingVault.toLowerCase() !== ZERO_ADDRESS) {
          toast.error('A vault already exists for this pair + fee tier in the current factory.')
          return
        }

        toast.error(
          'This pair + fee tier already has an initialized Uniswap pool from an older deployment. Use a fresh pair or unused fee tier so you do not inherit stale pool state.',
          { duration: 9000 }
        )
        return
      }
    } catch (poolCheckError) {
      console.warn('[CreateVault] Existing-pool check skipped:', poolCheckError)
    }

    let sqrtPriceX96: bigint
    const price = parseFloat(priceRatio)
    if (price <= 0 || isNaN(price)) {
      toast.error('Invalid price ratio')
      return
    }
    const effectivePrice = sorted.invertPrice ? (1 / price) : price
    const PRECISION = 10n ** 18n
    const effectivePriceString = effectivePrice.toFixed(18)
    const humanPriceScaled = parseUnits(effectivePriceString, 18)
    const numerator = humanPriceScaled * (10n ** BigInt(dec1))
    const denominator = PRECISION * (10n ** BigInt(dec0))

    try {
      // Use the factory's on-chain helper — exact Solidity integer math
      const result = await publicClient!.readContract({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI,
        functionName: 'computeSqrtPriceX96',
        args: [numerator, denominator],
      })
      sqrtPriceX96 = result as bigint
      console.log('[CreateVault] On-chain sqrtPriceX96:', sqrtPriceX96.toString())
    } catch (e) {
      // Fallback: JS computation if RPC fails
      const rawPrice = Number(numerator) / Number(denominator)
      const sqrtPrice = Math.sqrt(rawPrice)
      const Q96 = '79228162514264337593543950336'
      sqrtPriceX96 = BigInt(Math.round(sqrtPrice * 1e15)) * BigInt(Q96) / (10n ** 15n)
      console.log('[CreateVault] Fallback sqrtPriceX96:', sqrtPriceX96.toString())
    }

    if (sqrtPriceX96 === 0n) {
      toast.error('Invalid price ratio — sqrtPriceX96 is zero')
      return
    }

    const amount0Wei = parseUnits(sorted.amount0, dec0)
    const amount1Wei = parseUnits(sorted.amount1, dec1)
    const sttValue = parseEther(sttAmount)
    const hwInt = parseInt(halfWidth)

    // Debug logging
    console.log('[CreateVault] Params:', {
      token0: sorted.token0,
      token1: sorted.token1,
      fee: feeTier,
      sqrtPriceX96: sqrtPriceX96.toString(),
      amount0: amount0Wei.toString(),
      amount1: amount1Wei.toString(),
      halfWidth: hwInt,
      sttValue: sttAmount,
      invertPrice: sorted.invertPrice,
      dec0,
      dec1,
      rawNumerator: numerator.toString(),
      rawDenominator: denominator.toString(),
    })

    // ── Amount / price ratio mismatch check (prevents the 'T' revert) ────
    // Uniswap V3 mint() requires amounts proportional to the price curve.
    // If they're wildly off, it will revert with 'T' (TransferFailed).
    const amount0f = parseFloat(sorted.amount0)
    const amount1f = parseFloat(sorted.amount1)
    if (amount0f > 0 && amount1f > 0 && effectivePrice > 0) {
      const impliedRatio = amount1f / amount0f
      const factor = impliedRatio / effectivePrice
      if (factor > 50 || factor < 0.02) {
        toast.error(
          `⚠️ Amounts and price ratio are mismatched! ` +
          `Your price ratio is ${effectivePrice.toFixed(4)}, but your amounts imply ${impliedRatio.toFixed(4)}. ` +
          `If price ratio is ${effectivePrice.toFixed(2)}, deposit 100 of one token and ~${(100 * effectivePrice).toFixed(2)} of the other.`,
          { duration: 8000 }
        )
        return
      }
    }

    // ── Pre-flight simulation to catch reverts before MetaMask ────────────
    try {
      await publicClient!.simulateContract({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI,
        functionName: 'createVault',
        args: [
          sorted.token0 as `0x${string}`,
          sorted.token1 as `0x${string}`,
          feeTier,
          sqrtPriceX96,
          amount0Wei,
          amount1Wei,
          hwInt,
        ],
        value: sttValue,
        account: address,
      })
      console.log('[CreateVault] ✅ Pre-flight simulation passed')
    } catch (simError: any) {
      console.error('[CreateVault] ❌ Pre-flight simulation FAILED:', simError)
      const msg = simError?.message || ''
      if (msg.includes('InsufficientAllowance')) {
        toast.error('Insufficient token allowance — re-approve both tokens')
      } else if (msg.includes('VaultAlreadyExists')) {
        toast.error('A vault already exists for this token pair + fee tier!')
      } else if (msg.includes('InsufficientSTTFunding')) {
        toast.error('Need at least 32 STT — increase the STT amount')
      } else if (msg.includes('TokenTransferFailed')) {
        toast.error('Token transfer failed — check your token balances')
      } else if (/reason:\s*T[^A-Za-z]|"T"|reason: T$/m.test(msg)) {
        // Uniswap V3 'T' = TransferFailed — amounts don't fit the price curve
        toast.error(
          '🚨 Deposit amounts don\'t match the price ratio! ' +
          'Example: if price ratio is 2 (1 TokenA = 2 TokenB), deposit 50 TokenA + 100 TokenB. ' +
          'The amounts must reflect the actual market price.',
          { duration: 8000 }
        )
      } else {
        toast.error(`Simulation failed: ${msg.slice(0, 150)}`)
      }
      return
    }

    // ── Estimate gas dynamically (Somnia needs much more than 30M) ────
    let gasEstimate: bigint
    try {
      gasEstimate = await publicClient!.estimateContractGas({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI,
        functionName: 'createVault',
        args: [
          sorted.token0 as `0x${string}`,
          sorted.token1 as `0x${string}`,
          feeTier,
          sqrtPriceX96,
          amount0Wei,
          amount1Wei,
          hwInt,
        ],
        value: sttValue,
        account: address,
      })
      // Apply 2x multiplier for safety on Somnia
      gasEstimate = gasEstimate * 2n
      console.log('[CreateVault] Estimated gas (with 2x multiplier):', gasEstimate.toString())
    } catch {
      // If estimation fails, use a very high fallback
      gasEstimate = 100_000_000n
      console.log('[CreateVault] Gas estimation failed, using fallback:', gasEstimate.toString())
    }

    setStep('create')
    createVault({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: 'createVault',
      args: [
        sorted.token0 as `0x${string}`,
        sorted.token1 as `0x${string}`,
        feeTier,
        sqrtPriceX96,
        amount0Wei,
        amount1Wei,
        hwInt,
      ],
      value: sttValue,
      gas: gasEstimate,
    }, {
      onSuccess: () => toast.success('🎉 Vault creation submitted! Waiting for confirmation...'),
      onError: (err) => {
        console.error('[CreateVault] Error:', err)
        toast.error(`Creation failed: ${(err.message || '').slice(0, 120)}`)
        setStep('form')
      },
    })
  }

  // Parse VaultCreated event from receipt
  if (isCreateSuccess && createReceipt && !resultVault) {
    for (const log of createReceipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: FACTORY_ABI,
          data: log.data,
          topics: log.topics,
        })
        if (decoded.eventName === 'VaultCreated') {
          const args = decoded.args as any
          setResultVault(args.vault)
          setResultPool(args.pool)
          setStep('success')
        }
      } catch { /* skip non-matching logs */ }
    }
  }

  const isFormValid = tokenA.length === 42 && tokenB.length === 42 && tokenA !== tokenB &&
    parseFloat(amount0) > 0 && parseFloat(amount1) > 0 && parseFloat(sttAmount) >= 32

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate('/')}
          className="p-2 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-5 h-5 text-[var(--color-text-secondary)]" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Create New Vault</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Deploy a Uniswap V3 pool + FluxVault with automated JIT rebalancing
          </p>
        </div>
      </div>

      {step === 'success' ? (
        /* ── Success Screen ──────────────────────────────────────── */
        <GlassCard glow="green" className="space-y-6 text-center">
          <CheckCircle className="w-16 h-16 mx-auto text-[var(--color-neon-green)]" />
          <div>
            <h2 className="text-2xl font-bold text-[var(--color-text-primary)]">Vault Created! 🎉</h2>
            <p className="text-[var(--color-text-secondary)] mt-2">
              Your JIT rebalancing vault is deployed and initialized.
            </p>
          </div>

          <div className="space-y-3 text-left">
            <div className="glass p-4 rounded-xl">
              <p className="text-xs text-[var(--color-text-tertiary)] mb-1">Pool Address</p>
              <div className="flex items-center gap-2">
                <code className="text-sm font-mono text-[var(--color-neon-blue)]">{resultPool}</code>
                <a href={`${EXPLORER_URL}/address/${resultPool}`} target="_blank" rel="noreferrer">
                  <ExternalLink className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-neon-blue)]" />
                </a>
              </div>
            </div>
            <div className="glass p-4 rounded-xl">
              <p className="text-xs text-[var(--color-text-tertiary)] mb-1">Vault Address</p>
              <div className="flex items-center gap-2">
                <code className="text-sm font-mono text-[var(--color-neon-green)]">{resultVault}</code>
                <a href={`${EXPLORER_URL}/address/${resultVault}`} target="_blank" rel="noreferrer">
                  <ExternalLink className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-neon-blue)]" />
                </a>
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => navigate(`/vault/${resultPool}`)}
              className="flex-1 py-3 rounded-xl bg-[var(--color-neon-blue)] text-[var(--color-bg-primary)] font-semibold text-sm hover:opacity-90 transition-opacity cursor-pointer"
            >
              View Vault Dashboard →
            </button>
            <button
              onClick={() => navigate('/')}
              className="px-6 py-3 rounded-xl bg-white/5 text-[var(--color-text-secondary)] font-medium text-sm hover:bg-white/10 transition-colors cursor-pointer"
            >
              Home
            </button>
          </div>
        </GlassCard>
      ) : (
        /* ── Form ────────────────────────────────────────────────── */
        <div className="space-y-4">
          {!isConnected && (
            <GlassCard className="flex items-center gap-3 border-[var(--color-neon-amber)]/30">
              <AlertTriangle className="w-5 h-5 text-[var(--color-neon-amber)] shrink-0" />
              <p className="text-sm text-[var(--color-neon-amber)]">Connect your wallet to create a vault</p>
            </GlassCard>
          )}

          {/* Token Pair */}
          <GlassCard className="space-y-4">
            <h3 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Token Pair</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-[var(--color-text-tertiary)] mb-1 block">Token A Address</label>
                <input
                  type="text"
                  value={tokenA}
                  onChange={(e) => setTokenA(e.target.value.trim())}
                  placeholder="0x..."
                  className="w-full px-4 py-3 rounded-xl bg-[var(--color-bg-input)] border border-[var(--color-border)] text-sm font-mono text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-neon-blue)]/40 focus:outline-none transition-colors"
                />
                {token0Symbol && <p className="text-xs text-[var(--color-neon-blue)] mt-1 font-medium">{token0Symbol as string}</p>}
              </div>
              <div>
                <label className="text-xs text-[var(--color-text-tertiary)] mb-1 block">Token B Address</label>
                <input
                  type="text"
                  value={tokenB}
                  onChange={(e) => setTokenB(e.target.value.trim())}
                  placeholder="0x..."
                  className="w-full px-4 py-3 rounded-xl bg-[var(--color-bg-input)] border border-[var(--color-border)] text-sm font-mono text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-neon-blue)]/40 focus:outline-none transition-colors"
                />
                {token1Symbol && <p className="text-xs text-[var(--color-neon-blue)] mt-1 font-medium">{token1Symbol as string}</p>}
              </div>
            </div>
          </GlassCard>

          {/* Fee Tier */}
          <GlassCard className="space-y-3">
            <h3 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Fee Tier</h3>
            <div className="grid grid-cols-3 gap-2">
              {FEE_TIERS.map((tier) => (
                <button
                  key={tier.value}
                  onClick={() => setFeeTier(tier.value)}
                  className={`p-3 rounded-xl text-center transition-all cursor-pointer ${
                    feeTier === tier.value
                      ? 'bg-[var(--color-neon-blue)]/10 border border-[var(--color-neon-blue)]/30 text-[var(--color-neon-blue)]'
                      : 'bg-[var(--color-bg-input)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-hover)]'
                  }`}
                >
                  <p className="text-lg font-bold">{tier.label}</p>
                  <p className="text-[10px] mt-0.5 opacity-70">{tier.description}</p>
                </button>
              ))}
            </div>
          </GlassCard>

          {/* Price & Amounts */}
          <GlassCard className="space-y-4">
            <h3 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Price & Deposits</h3>
            <div>
              <label className="text-xs text-[var(--color-text-tertiary)] mb-1 block">
                Initial Price Ratio (Token B per Token A)
              </label>
              <input
                type="number"
                value={priceRatio}
                onChange={(e) => setPriceRatio(e.target.value)}
                min="0"
                step="0.01"
                className="w-full px-4 py-3 rounded-xl bg-[var(--color-bg-input)] border border-[var(--color-border)] text-sm font-mono text-[var(--color-text-primary)] focus:border-[var(--color-neon-blue)]/40 focus:outline-none transition-colors"
              />
              <p className="text-[10px] text-[var(--color-text-tertiary)] mt-1">For 1:1 peg (e.g. stablecoins), use 1</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-[var(--color-text-tertiary)] mb-1 block">
                  Deposit {token0Symbol ? `(${token0Symbol})` : 'Token A'}
                </label>
                <input
                  type="number"
                  value={amount0}
                  onChange={(e) => setAmount0(e.target.value)}
                  min="0"
                  step="0.1"
                  className="w-full px-4 py-3 rounded-xl bg-[var(--color-bg-input)] border border-[var(--color-border)] text-sm font-mono text-[var(--color-text-primary)] focus:border-[var(--color-neon-blue)]/40 focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label className="text-xs text-[var(--color-text-tertiary)] mb-1 block">
                  Deposit {token1Symbol ? `(${token1Symbol})` : 'Token B'}
                </label>
                <input
                  type="number"
                  value={amount1}
                  onChange={(e) => setAmount1(e.target.value)}
                  min="0"
                  step="0.1"
                  className="w-full px-4 py-3 rounded-xl bg-[var(--color-bg-input)] border border-[var(--color-border)] text-sm font-mono text-[var(--color-text-primary)] focus:border-[var(--color-neon-blue)]/40 focus:outline-none transition-colors"
                />
              </div>
            </div>
          </GlassCard>

          {/* Advanced */}
          <GlassCard className="space-y-4">
            <h3 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Advanced</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-[var(--color-text-tertiary)] mb-1 block">Half Width (ticks)</label>
                <input
                  type="number"
                  value={halfWidth}
                  onChange={(e) => setHalfWidth(e.target.value)}
                  min="1"
                  className="w-full px-4 py-3 rounded-xl bg-[var(--color-bg-input)] border border-[var(--color-border)] text-sm font-mono text-[var(--color-text-primary)] focus:border-[var(--color-neon-blue)]/40 focus:outline-none transition-colors"
                />
                <p className="text-[10px] text-[var(--color-text-tertiary)] mt-1">600 = ±6% range</p>
              </div>
              <div>
                <label className="text-xs text-[var(--color-text-tertiary)] mb-1 block">STT Funding</label>
                <input
                  type="number"
                  value={sttAmount}
                  onChange={(e) => setSttAmount(e.target.value)}
                  min="32"
                  className="w-full px-4 py-3 rounded-xl bg-[var(--color-bg-input)] border border-[var(--color-border)] text-sm font-mono text-[var(--color-text-primary)] focus:border-[var(--color-neon-blue)]/40 focus:outline-none transition-colors"
                />
                <p className="text-[10px] text-[var(--color-text-tertiary)] mt-1">Min 32 STT for Reactivity</p>
              </div>
            </div>
          </GlassCard>

          {/* Action Buttons */}
          <GlassCard className="space-y-3">
            <h3 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Execute</h3>

            {/* Step indicator */}
            <div className="flex items-center gap-2 text-xs">
              {(['approve0', 'approve1', 'create'] as const).map((s, i) => {
                const labels = ['Approve Token 0', 'Approve Token 1', 'Create Vault']
                const isDone = (s === 'approve0' && isToken0Approved) ||
                  (s === 'approve1' && isToken1Approved) ||
                  (s === 'create' && isCreateSuccess)
                const isCurrent = step === s
                return (
                  <div key={s} className="flex items-center gap-2">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all ${
                      isDone ? 'bg-[var(--color-neon-green)]/20 text-[var(--color-neon-green)]'
                      : isCurrent ? 'bg-[var(--color-neon-blue)]/20 text-[var(--color-neon-blue)] animate-pulse'
                      : 'bg-white/5 text-[var(--color-text-tertiary)]'
                    }`}>
                      {isDone ? '✓' : i + 1}
                    </div>
                    <span className={isDone ? 'text-[var(--color-neon-green)]' : isCurrent ? 'text-[var(--color-neon-blue)]' : 'text-[var(--color-text-tertiary)]'}>
                      {labels[i]}
                    </span>
                    {i < 2 && <span className="text-[var(--color-text-tertiary)]">→</span>}
                  </div>
                )
              })}
            </div>

            <div className="flex gap-2">
              {/* Approve Token 0 */}
              <button
                onClick={handleApprove0}
                disabled={!isConnected || !isFormValid || isApprove0Loading || isToken0Approved}
                className={`flex-1 py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer ${
                  isToken0Approved
                    ? 'bg-[var(--color-neon-green)]/10 text-[var(--color-neon-green)] border border-[var(--color-neon-green)]/20'
                    : 'bg-[var(--color-neon-blue)]/10 text-[var(--color-neon-blue)] border border-[var(--color-neon-blue)]/20 hover:bg-[var(--color-neon-blue)]/20 disabled:opacity-40 disabled:cursor-not-allowed'
                }`}
              >
                {isApprove0Loading ? <Loader2 className="w-4 h-4 animate-spin" /> : isToken0Approved ? <CheckCircle className="w-4 h-4" /> : <Coins className="w-4 h-4" />}
                {isToken0Approved ? 'Approved' : isApprove0Loading ? 'Confirming...' : 'Approve 0'}
              </button>

              {/* Approve Token 1 */}
              <button
                onClick={handleApprove1}
                disabled={!isConnected || !isFormValid || !isToken0Approved || isApprove1Loading || isToken1Approved}
                className={`flex-1 py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer ${
                  isToken1Approved
                    ? 'bg-[var(--color-neon-green)]/10 text-[var(--color-neon-green)] border border-[var(--color-neon-green)]/20'
                    : 'bg-[var(--color-neon-blue)]/10 text-[var(--color-neon-blue)] border border-[var(--color-neon-blue)]/20 hover:bg-[var(--color-neon-blue)]/20 disabled:opacity-40 disabled:cursor-not-allowed'
                }`}
              >
                {isApprove1Loading ? <Loader2 className="w-4 h-4 animate-spin" /> : isToken1Approved ? <CheckCircle className="w-4 h-4" /> : <Coins className="w-4 h-4" />}
                {isToken1Approved ? 'Approved' : isApprove1Loading ? 'Confirming...' : 'Approve 1'}
              </button>
            </div>

            {/* Create Vault */}
            <button
              onClick={handleCreateVault}
              disabled={!isConnected || !isFormValid || !isToken0Approved || !isToken1Approved || isCreateLoading}
              className="w-full py-4 rounded-xl bg-gradient-to-r from-[var(--color-neon-blue)] to-[var(--color-neon-purple)] text-white font-bold text-base flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {isCreateLoading ? (
                <><Loader2 className="w-5 h-5 animate-spin" /> Creating Vault...</>
              ) : (
                <><Zap className="w-5 h-5" /> Deploy Vault + Pool</>
              )}
            </button>
          </GlassCard>
        </div>
      )}
    </div>
  )
}
