import { PublicKey } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import axios from "axios";
import { BaseDex } from "../BaseDex";
import type { DexConfig, PoolPrice, Pool } from "../../types";
import { meteoraPoolParser, MeteoraApiPool } from "./parser";

export class MeteoraDex extends BaseDex {
    public readonly name = "Meteora";
    private readonly apiUrl = 'https://dlmm-api.meteora.ag/pair/all';

    constructor(config: DexConfig) {
        super(config);
    }

    public async getPoolPrice(poolAddress: string, poolType?: string): Promise<PoolPrice> {
        const poolPk = new PublicKey(poolAddress);
        const dlmmPool = await DLMM.create(this.connection, poolPk);
        const activeBin = await dlmmPool.getActiveBin();
        const priceStr = dlmmPool.fromPricePerLamport(Number(activeBin.price));
        const price = parseFloat(priceStr);
        const lbPair = dlmmPool.lbPair;

        return this.buildPoolPrice(
            poolAddress,
            price,
            lbPair.tokenXMint.toBase58(),
            lbPair.tokenYMint.toBase58()
        );
    }

    public async getPoolList(): Promise<Pool[]> {
        try {
            console.log(`⏳  Fetching Meteora pools...`);
            const response = await axios.get<MeteoraApiPool[]>(this.apiUrl);
            return meteoraPoolParser(response.data);
        } catch (e) {
            console.error(`❌ Meteora getPoolList error: ${e}`);
            return [];
        }
    }
}
