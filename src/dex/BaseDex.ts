import { Connection, PublicKey } from "@solana/web3.js";
import type { DexConfig, PoolPrice, Pool } from "../types";

/**
 * Abstract base class for Solana DEX adapters.
 *
 * Every concrete adapter (Raydium, Whirlpool, Meteora) must extend this class
 * and implement {@link BaseDex.getPoolPrice} and {@link BaseDex.getPoolList}.
 */
export abstract class BaseDex {
    /** Human-readable name of the DEX protocol */
    public abstract readonly name: string;

    /** Shared Solana RPC connection used by all adapters */
    protected readonly connection: Connection;

    /** Cache for token decimals to avoid redundant RPC calls */
    protected static decimalCache: Map<string, number> = new Map();

    constructor(config: DexConfig) {
        this.connection = new Connection(config.rpcUrl, config.commitment || "confirmed");
    }

    /**
     * Helper to get mint decimals with caching.
     */
    protected async getCachedMintDecimals(mint: string): Promise<number> {
        const cached = BaseDex.decimalCache.get(mint);
        if (cached !== undefined) return cached;

        const info = await this.connection.getParsedAccountInfo(new PublicKey(mint));
        const decimals = (info.value?.data as any)?.parsed?.info?.decimals ?? 6;
        BaseDex.decimalCache.set(mint, decimals);
        return decimals;
    }


    /**
     * Fetch the current spot price for the given pool.
     *
     * @param poolAddress - On-chain address of the AMM pool
     * @returns Resolved {@link PoolPrice} or rejects with an error
     */
    public abstract getPoolPrice(poolAddress: string, poolType?: string): Promise<PoolPrice>;

    /**
     * Fetch all available pools (or a subset) for the DEX.
     *
     * @returns List of {@link Pool} objects
     */
    public abstract getPoolList(): Promise<Pool[]>;

    /**
     * Helper – returns a base {@link PoolPrice} skeleton populated with the
     * common fields so subclasses only have to fill in the price-specific data.
     */
    protected buildPoolPrice(
        poolAddress: string,
        price: number,
        tokenAMint: string,
        tokenBMint: string
    ): PoolPrice {
        return {
            dex: this.name,
            poolAddress,
            price,
            tokenAMint,
            tokenBMint,
            fetchedAt: new Date().toISOString(),
        };
    }
}

