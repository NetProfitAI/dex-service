import { PublicKey } from "@solana/web3.js";
import { createProgram, decodeAccount, getPriceOfBinByBinId } from "@meteora-ag/dlmm";
import Decimal from "decimal.js";
import axios from "axios";
import { BaseDex } from "../BaseDex";
import type { DexConfig, PoolPrice, Pool } from "../../types";
import { meteoraPoolParser, MeteoraApiResponse } from "./parser";

export class MeteoraDex extends BaseDex {
    public readonly name = "Meteora";
    private readonly apiUrl = 'https://dlmm.datapi.meteora.ag/pools';
    private static readonly PAGE_SIZE = 700;

    /** Anchor program used purely to decode lbPair accounts offline (no RPC). */
    private program: ReturnType<typeof createProgram> | null = null;

    constructor(config: DexConfig) {
        super(config);
    }

    public async getPoolPrice(poolAddress: string, poolType?: string): Promise<PoolPrice> {
        // Single RPC round-trip: fetch the lbPair account and derive the price from it.
        const account = await this.connection.getAccountInfo(new PublicKey(poolAddress));
        if (!account) throw new Error(`Meteora pool account not found: ${poolAddress}`);
        return this.priceFromLbPairData(poolAddress, account.data);
    }

    /**
     * Derive the active-bin price straight from a raw lbPair account buffer.
     * Token decimals come from the shared cache, so repeated calls (and live
     * subscription updates) issue no extra RPC requests.
     */
    private async priceFromLbPairData(poolAddress: string, data: Buffer): Promise<PoolPrice> {
        const lbPair = decodeAccount(this.getProgram(), "lbPair", data) as {
            activeId: number;
            binStep: number;
            tokenXMint: PublicKey;
            tokenYMint: PublicKey;
        };

        const mintX = lbPair.tokenXMint.toBase58();
        const mintY = lbPair.tokenYMint.toBase58();
        const [decimalsX, decimalsY] = await Promise.all([
            this.getCachedMintDecimals(mintX),
            this.getCachedMintDecimals(mintY),
        ]);

        // price = (1 + binStep/10000)^activeId * 10^(decimalsX - decimalsY)
        const price = getPriceOfBinByBinId(lbPair.activeId, lbPair.binStep)
            .mul(new Decimal(10).pow(decimalsX - decimalsY))
            .toNumber();

        return this.buildPoolPrice(poolAddress, price, mintX, mintY);
    }

    private getProgram(): ReturnType<typeof createProgram> {
        if (!this.program) this.program = createProgram(this.connection);
        return this.program;
    }

    public async getPoolList(): Promise<Pool[]> {
        try {
            let currentPage = 1;
            let hasNextPage = true;
            let data: Pool[] = [];

            // Pools are returned sorted by TVL descending, so we can stop as soon as
            // we hit a page that contains pools with no liquidity.
            while (hasNextPage) {
                console.log(`⏳  Fetching Meteora pools page ${currentPage}...`);
                const response = await axios.get<MeteoraApiResponse>(this.apiUrl, {
                    params: {
                        page: currentPage,
                        page_size: MeteoraDex.PAGE_SIZE,
                        sort_by: "tvl:desc",
                    },
                });

                const pools = response.data.data ?? [];
                const hasZeroLiquidity = pools.some((pool) => (pool.tvl || 0) <= 0);
                const liquidPools = pools.filter((pool) => (pool.tvl || 0) > 0);
                data = data.concat(meteoraPoolParser(liquidPools));

                if (hasZeroLiquidity || pools.length === 0) {
                    console.log(`⏹️  Stopping at page ${currentPage}: found pools with 0 liquidity.`);
                    hasNextPage = false;
                } else {
                    hasNextPage = response.data.current_page < response.data.pages;
                }

                currentPage++;
            }

            return data;
        } catch (e) {
            console.error(`❌ Meteora getPoolList error: ${e}`);
            return [];
        }
    }

    public async subscribeToPrice(
        poolAddress: string,
        callback: (priceData: PoolPrice) => void,
        poolType?: string
    ): Promise<number> {
        const addr = new PublicKey(poolAddress);
        // The subscription already pushes the updated lbPair account, so decode it
        // directly instead of re-fetching — zero extra RPC per price update.
        return this.connection.onAccountChange(addr, async (accountInfo) => {
            try {
                const priceData = await this.priceFromLbPairData(poolAddress, accountInfo.data);
                callback(priceData);
            } catch (err) {
                console.error(`[Meteora] Subscription update failed for ${poolAddress}:`, err);
            }
        }, this.connection.commitment);
    }

    public async unsubscribe(subscriptionId: number): Promise<void> {
        try {
            await this.connection.removeAccountChangeListener(subscriptionId);
        } catch (err) {
            console.error(`[Meteora] Failed to unsubscribe ${subscriptionId}:`, err);
        }
    }
}
