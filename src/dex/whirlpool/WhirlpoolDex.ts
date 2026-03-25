import { createSolanaRpc } from "@solana/rpc";
import { address } from "@solana/addresses";
import type { Rpc, GetAccountInfoApi, GetMultipleAccountsApi } from "@solana/kit";
import { fetchWhirlpool } from "@orca-so/whirlpools-client";
import { sqrtPriceToPrice } from "@orca-so/whirlpools-core";
import axios from "axios";
import { BaseDex } from "../BaseDex";
import type { DexConfig, PoolPrice, Pool } from "../../types";
import { parseWhirlpoolPools, WhirlpoolApiResponse } from "./parser";

export class WhirlpoolDex extends BaseDex {
    public readonly name = "Whirlpool";
    private readonly kitRpc: Rpc<GetAccountInfoApi & GetMultipleAccountsApi>;
    private readonly apiUrl = 'https://api.mainnet.orca.so/v1/whirlpool/list';

    constructor(config: DexConfig) {
        super(config);
        this.kitRpc = createSolanaRpc(config.rpcUrl) as Rpc<
            GetAccountInfoApi & GetMultipleAccountsApi
        >;
    }

    public async getPoolPrice(poolAddress: string, poolType?: string): Promise<PoolPrice> {
        const poolAccount = await fetchWhirlpool(this.kitRpc, address(poolAddress));
        const pool = poolAccount.data;

        // Use cached decimals to avoid extra RPC calls
        const [decimalsA, decimalsB] = await Promise.all([
            this.getCachedMintDecimals(pool.tokenMintA),
            this.getCachedMintDecimals(pool.tokenMintB),
        ]);

        const price = sqrtPriceToPrice(pool.sqrtPrice, decimalsA, decimalsB);

        return this.buildPoolPrice(
            poolAddress,
            price,
            pool.tokenMintA,
            pool.tokenMintB
        );
    }

    public async getPoolList(): Promise<Pool[]> {
        try {
            console.log(`⏳  Fetching Whirlpool pools...`);
            // Adding Accept-Encoding header to avoid potential decompression issues
            const response = await axios.get<WhirlpoolApiResponse>(this.apiUrl, {
                headers: {
                    'Accept-Encoding': 'identity'
                }
            });
            return parseWhirlpoolPools(response.data.whirlpools);
        } catch (e) {
            console.error(`❌ Whirlpool getPoolList error: ${e}`);
            return [];
        }
    }
}
