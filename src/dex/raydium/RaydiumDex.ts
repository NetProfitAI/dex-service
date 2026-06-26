import {
    Raydium,
    PoolFetchType,
    ApiV3PoolInfoItem,
} from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import { BaseDex } from "../BaseDex";

import type { DexConfig, PoolPrice, Pool } from "../../types";
import { parseRaydiumPool } from "./parser";

export class RaydiumDex extends BaseDex {
    public readonly name = "Raydium";
    private sdk: Raydium | null = null;

    // Raydium Program IDs for identifying pool types
    private static readonly PROGRAMS = {
        CLMM: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
        CPMM: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
        AMM_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
        AMM_STABLE: "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h",
    };

    constructor(config: DexConfig) {
        super(config);
    }


    public async getPoolPrice(poolAddress: string, poolType?: string): Promise<PoolPrice> {
        const raydium = await this.initSdk();

        // 1. Use Provided Type
        const typeStr = poolType?.toLowerCase();
        if (typeStr === "clmm") return this.getClmmPrice(raydium, poolAddress);
        if (typeStr === "cpmm") return this.getCpmmPrice(raydium, poolAddress);
        if (typeStr === "amm") return this.getAmmV4Price(raydium, poolAddress);

        // 2. Identify Pool Type (Fastest way is checking account owner)
        try {
            const accountInfo = await this.connection.getAccountInfo(new PublicKey(poolAddress));
            if (!accountInfo) throw new Error("Pool account not found");

            const owner = accountInfo.owner.toBase58();

            if (owner === RaydiumDex.PROGRAMS.CLMM) {
                return await this.getClmmPrice(raydium, poolAddress);
            } else if (owner === RaydiumDex.PROGRAMS.CPMM) {
                return await this.getCpmmPrice(raydium, poolAddress);
            } else if (owner === RaydiumDex.PROGRAMS.AMM_V4 || owner === RaydiumDex.PROGRAMS.AMM_STABLE) {
                return await this.getAmmV4Price(raydium, poolAddress);
            }
        } catch (e) {
            console.error(`[Raydium] Direct owner check failed for ${poolAddress}, falling back to parallel try...`);
        }

        // 3. Last Resort: Parallel Discovery
        return await Promise.any([
            this.getClmmPrice(raydium, poolAddress),
            this.getCpmmPrice(raydium, poolAddress),
            this.getAmmV4Price(raydium, poolAddress),
        ]).catch(() => {
            throw new Error(`Failed to fetch price for Raydium pool ${poolAddress}: Unrecognized pool type or RPC error`);
        });
    }


    public async getPoolList(): Promise<Pool[]> {
        const raydium = await this.initSdk();

        const doRequest = async (page: number) => {
            return await raydium.api.getPoolList({
                type: PoolFetchType.All,
                sort: "liquidity",
                order: "desc",
                pageSize: 700, // Reduced from 999 to be safer with RPC/API limits
                page,
            });
        };

        let currentPage = 1;
        let hasNextPage = true;
        let data: ApiV3PoolInfoItem[] = [];

        while (hasNextPage) {
            console.log(`⏳  Fetching Raydium pools page ${currentPage}...`);
            const requestResponse = await doRequest(currentPage);

            // Explicitly validate if any pool in the current page has 0 liquidity
            const hasZeroLiquidity = requestResponse.data.some(pool => (pool.tvl || 0) <= 0);

            // Filter only pools with liquidity
            const liquidPools = requestResponse.data.filter(pool => (pool.tvl || 0) > 0);
            data = data.concat(liquidPools);

            if (hasZeroLiquidity || requestResponse.data.length === 0) {
                console.log(`⏹️  Stopping at page ${currentPage}: found pools with 0 liquidity.`);
                hasNextPage = false;
            } else {
                hasNextPage = requestResponse.hasNextPage;
            }

            currentPage++;
        }

        return parseRaydiumPool(data);
    }

    public async subscribeToPrice(
        poolAddress: string,
        callback: (priceData: PoolPrice) => void,
        poolType?: string
    ): Promise<number> {
        const addr = new PublicKey(poolAddress);

        // Use Solana's onAccountChange to detect when the pool's state is updated on chain.
        // This is triggered by trades/liquidity changes, making it true real-time.
        return this.connection.onAccountChange(addr, async (accountInfo, context) => {
            try {
                // When account changes, we re-fetch the calculated price.
                const priceData = await this.getPoolPrice(poolAddress, poolType);
                callback(priceData);
            } catch (err) {
                console.error(`[Raydium] Subscription update failed for ${poolAddress}:`, err);
            }
        }, {
            commitment: this.connection.commitment,
            encoding: 'jsonParsed'
        });
    }

    public async unsubscribe(subscriptionId: number): Promise<void> {
        try {
            await this.connection.removeAccountChangeListener(subscriptionId);
        } catch (err) {
            console.error(`[Raydium] Failed to unsubscribe ${subscriptionId}:`, err);
        }
    }

    private async initSdk(): Promise<Raydium> {
        if (!this.sdk) {
            this.sdk = await Raydium.load({
                connection: this.connection,
                disableLoadToken: true, // Speeds up loading significantly
            });
        }

        return this.sdk;
    }

    private async getClmmPrice(raydium: Raydium, poolId: string): Promise<PoolPrice> {
        const poolInfo = (await raydium.clmm.getRpcClmmPoolInfos({ poolIds: [poolId] }))[poolId];
        if (!poolInfo) return this.buildPoolPrice(poolId, 0, "", "");
        const price = poolInfo.currentPrice;
        return this.buildPoolPrice(poolId, price, poolInfo.mintA.toString(), poolInfo.mintB.toString());
    }

    private async getCpmmPrice(raydium: Raydium, poolId: string): Promise<PoolPrice> {
        // Single RPC fetch of the pool account; `false` skips the extra config request.
        const poolInfo = await raydium.cpmm.getRpcPoolInfo(poolId, false);
        if (poolInfo.baseReserve.isZero()) throw new Error("Zero reserve A");
        return this.buildPoolPrice(
            poolId,
            poolInfo.poolPrice.toNumber(),
            poolInfo.mintA.toBase58(),
            poolInfo.mintB.toBase58()
        );
    }

    private async getAmmV4Price(raydium: Raydium, poolId: string): Promise<PoolPrice> {
        // Single RPC fetch of the pool account (getPoolInfoFromRpc fans out to market/vault accounts).
        const data = await raydium.liquidity.getRpcPoolInfo(poolId);
        if (data.baseReserve.isZero()) throw new Error("Zero reserve A");
        return this.buildPoolPrice(
            poolId,
            data.poolPrice.toNumber(),
            data.baseMint.toBase58(),
            data.quoteMint.toBase58()
        );
    }
}
