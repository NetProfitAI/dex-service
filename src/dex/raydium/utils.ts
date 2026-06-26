import { ClmmParsedRpcData, CpmmParsedRpcData, AmmRpcData } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";

/**
 * Calculates the estimated output amount for a CPMM (Constant Product) swap.
 * Uses the standard AMM formula: dy = (y * dx) / (x + dx)
 * where x = input reserve, y = output reserve, dx = input amount.
 *
 * @param amountIn The amount of tokens being swapped in (in raw units/lamports)
 * @param inputMint The public key string of the token being sent
 * @param poolData The decoded CPMM pool data from RPC
 * @param fee The trade fee rate (e.g. 0.0025 for 0.25%). If not provided, it will be read from poolData.configInfo.tradeFeeRate
 * @returns The estimated output amount (in raw units/lamports)
 */
export function calculateCpmmOutAmount(
    amountIn: BN,
    inputMint: string,
    poolData: CpmmParsedRpcData
): BN {
    const {
        mintA,
        mintB,
        baseReserve,
        quoteReserve,
        configInfo,
    } = poolData;

    // 1. Validate reserves
    if (baseReserve.isZero() || quoteReserve.isZero()) {
        throw new Error("Pool has zero reserves — cannot swap");
    }

    // 2. Determine swap direction
    const isAToB = inputMint === mintA.toString();
    if (!isAToB && inputMint !== mintB.toString()) {
        throw new Error(`Input mint ${inputMint} does not match pool mints`);
    }

    const inputReserve = isAToB ? baseReserve : quoteReserve;
    const outputReserve = isAToB ? quoteReserve : baseReserve;

    // 3. Resolve fee rate
    //    configInfo.tradeFeeRate is denominated in 1e9 (e.g., 2_500_000 = 0.25%)
    const FEE_DENOMINATOR = 1_000_000_000;
    const feeRate = configInfo
        ? configInfo.tradeFeeRate.toNumber() / FEE_DENOMINATOR
        : 0.0025 // default 0.25% if config unavailable


    // 4. Apply fee to input amount
    const floatAmountIn = parseFloat(amountIn.toString());
    const effectiveAmountIn = floatAmountIn * (1 - feeRate);

    // 5. Constant Product Formula: dy = (y * dx) / (x + dx)
    const x = parseFloat(inputReserve.toString());
    const y = parseFloat(outputReserve.toString());

    const amountOut = (y * effectiveAmountIn) / (x + effectiveAmountIn);

    // 6. Price impact check
    //    Price impact ≈ dx / (x + dx)  (for constant product)
    const priceImpact = effectiveAmountIn / (x + effectiveAmountIn);
    if (priceImpact > 0.05) {
        console.warn(
            `[CPMM] High price impact warning: ${(priceImpact * 100).toFixed(2)}%`
        );
    }

    const finalAmountOut = Math.floor(amountOut);
    return new BN(finalAmountOut > 0 ? finalAmountOut : 0);
}


/**
 * Raydium standard CLMM config tiers: tickSpacing → tradeFeeRate
 * These are the well-known fee tiers used by Raydium's CLMM program.
 */
const CLMM_FEE_TIERS: Record<number, number> = {
    1: 0.0001,  // 0.01%
    10: 0.0005,  // 0.05%
    60: 0.0025,  // 0.25%
    120: 0.01,    // 1%
};

/**
 * Calculates the estimated output amount for a CLMM swap.
 * Incorporates price impact based on virtual liquidity L.
 * Fee is derived automatically from poolData.tickSpacing using Raydium's standard config tiers.
 *
 * @param amountIn The amount of tokens being swapped in (in raw units/lamports)
 * @param inputMint The public key string of the token being sent
 * @param poolData The decoded CLMM pool data from RPC (via getRpcClmmPoolInfos)
 * @returns The estimated output amount (in raw units/lamports)
 */
export function calculateClmmOutAmount(
    amountIn: BN,
    inputMint: string,
    poolData: ClmmParsedRpcData,
): BN {
    const {
        sqrtPriceX64,
        mintA,
        mintB,
        liquidity,
        tickSpacing,
    } = poolData;

    // 1. Resolve fee rate from tickSpacing
    const fee = CLMM_FEE_TIERS[tickSpacing];
    if (fee === undefined) {
        throw new Error(`[CLMM] Unknown tickSpacing ${tickSpacing} — cannot determine fee rate`);
    }

    // 2. Validate liquidity
    if (liquidity.isZero()) {
        throw new Error("Pool has no active liquidity at the current price");
    }

    const isZeroForOne = inputMint === mintA.toString();

    // 3. Square Root Price (sqrtP) in raw units (sqrt(B_lamports / A_lamports))
    const Q64 = new BN(1).ushln(64);
    const sqrtP = parseFloat(sqrtPriceX64.toString()) / parseFloat(Q64.toString());

    const floatAmountIn = parseFloat(amountIn.toString());
    const floatLiquidity = parseFloat(liquidity.toString());

    /**
     * Enough liquidity check:
     * In CLMM, price impact is roughly (amountIn * sqrtP) / L.
     * If this is extremely large, the swap might exceed the current tick array or pool depth.
     */
    let amountOut: number;

    if (isZeroForOne) {
        /**
         * Case: Swapping Token A -> Token B
         * Formula: DeltaY = (DeltaX * P) / (1 + DeltaX * sqrtP / L)
         */
        const priceImpact = (floatAmountIn * sqrtP) / floatLiquidity;
        if (priceImpact > 0.5) {
            console.warn(`[CLMM] Extremely high price impact warning: ${Math.round(priceImpact * 100)}%`);
        }

        const priceAtoB = Math.pow(sqrtP, 2);
        amountOut = (floatAmountIn * priceAtoB) / (1 + priceImpact);
    } else {
        /**
         * Case: Swapping Token B -> Token A
         * Formula: DeltaX = (DeltaY / P) / (1 + DeltaY / (L * sqrtP))
         */
        const priceImpact = floatAmountIn / (floatLiquidity * sqrtP);
        if (priceImpact > 0.5) {
            console.warn(`[CLMM] Extremely high price impact warning: ${Math.round(priceImpact * 100)}%`);
        }

        const priceBtoA = 1 / Math.pow(sqrtP, 2);
        amountOut = (floatAmountIn * priceBtoA) / (1 + priceImpact);
    }

    // 4. Subtract Pool Fees
    const feeMultiplier = 1 - fee;
    const finalAmountOut = Math.floor(amountOut * feeMultiplier);

    return new BN(finalAmountOut > 0 ? finalAmountOut : 0);
}


/**
 * Calculates the estimated output amount for a Raydium AMM V4/V5 swap.
 * Uses the constant product formula: dy = (y * dx) / (x + dx)
 * Fee is read from poolData.tradeFeeNumerator / poolData.tradeFeeDenominator.
 *
 * @param amountIn The amount of tokens being swapped in (in raw units/lamports)
 * @param inputMint The public key string of the token being sent
 * @param poolData The decoded AMM pool data from RPC (via getRpcPoolInfo / getRpcPoolInfos)
 * @returns The estimated output amount (in raw units/lamports)
 */
export function calculateAmmOutAmount(
    amountIn: BN,
    inputMint: string,
    poolData: AmmRpcData
): BN {
    const {
        baseMint,
        quoteMint,
        baseReserve,
        quoteReserve,
        tradeFeeNumerator,
        tradeFeeDenominator,
    } = poolData;

    // 1. Validate reserves
    if (baseReserve.isZero() || quoteReserve.isZero()) {
        throw new Error("Pool has zero reserves — cannot swap");
    }

    // 2. Determine swap direction
    const isBaseToQuote = inputMint === baseMint.toString();
    if (!isBaseToQuote && inputMint !== quoteMint.toString()) {
        throw new Error(`Input mint ${inputMint} does not match pool mints`);
    }

    const inputReserve = isBaseToQuote ? baseReserve : quoteReserve;
    const outputReserve = isBaseToQuote ? quoteReserve : baseReserve;

    // 3. Resolve fee rate from on-chain numerator/denominator
    //    Raydium AMM V4 default: 25 / 10000 = 0.25%
    const feeNum = tradeFeeNumerator.toNumber();
    const feeDen = tradeFeeDenominator.toNumber();
    const feeRate = feeDen > 0 ? feeNum / feeDen : 0.0025;

    // 4. Apply fee to input amount
    const floatAmountIn = parseFloat(amountIn.toString());
    const effectiveAmountIn = floatAmountIn * (1 - feeRate);

    // 5. Constant Product Formula: dy = (y * dx) / (x + dx)
    const x = parseFloat(inputReserve.toString());
    const y = parseFloat(outputReserve.toString());

    const amountOut = (y * effectiveAmountIn) / (x + effectiveAmountIn);

    // 6. Price impact check
    const priceImpact = effectiveAmountIn / (x + effectiveAmountIn);
    if (priceImpact > 0.05) {
        console.warn(
            `[AMM] High price impact warning: ${(priceImpact * 100).toFixed(2)}%`
        );
    }

    const finalAmountOut = Math.floor(amountOut);
    return new BN(finalAmountOut > 0 ? finalAmountOut : 0);
}



