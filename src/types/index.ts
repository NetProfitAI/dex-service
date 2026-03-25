/**
 * Unified pool information.
 */
export interface Pool {
    dex: string;
    address: string;
    tokenAMint: string;
    tokenBMint: string;
    tokenAName?: string;
    tokenBName?: string;
    tokenASymbol?: string;
    tokenBSymbol?: string;
    liquidity?: number;
    volume24h?: number;
    fee?: number;
    poolType?: string;
}

/**
 * Unified result returned by every DEX adapter when fetching a pool price.
 */
export interface PoolPrice {
    /** Human-readable DEX name, e.g. "Raydium", "Whirlpool", "Meteora" */
    dex: string;

    /** On-chain address of the pool */
    poolAddress: string;

    /**
     * Spot price expressed as tokenB per tokenA.
     * e.g. if the pair is SOL/USDC this would be the USDC amount per 1 SOL.
     */
    price: number;

    /** Base token mint address */
    tokenAMint: string;

    /** Quote token mint address */
    tokenBMint: string;

    /** ISO-8601 timestamp of when the price was fetched */
    fetchedAt: string;
}

/**
 * Configuration consumed by every DEX adapter on construction.
 */
export interface DexConfig {
    /** Solana JSON-RPC endpoint */
    rpcUrl: string;
    /** Commitment level for RPC requests (default: 'confirmed') */
    commitment?: "processed" | "confirmed" | "finalized";
}

