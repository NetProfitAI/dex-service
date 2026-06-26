import { Pool } from "../../types";

interface MeteoraApiToken {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
}

export interface MeteoraApiPool {
    address: string;
    name: string;
    token_x: MeteoraApiToken;
    token_y: MeteoraApiToken;
    tvl: number;
    volume?: Record<string, number>;
    pool_config?: {
        base_fee_pct: number;
    };
}

/** Shape of the paginated response from https://dlmm.datapi.meteora.ag/pools */
export interface MeteoraApiResponse {
    total: number;
    pages: number;
    current_page: number;
    page_size: number;
    data: MeteoraApiPool[];
}

export function meteoraPoolParser(data: MeteoraApiPool[]): Pool[] {
    return data.map((pool) => ({
        dex: "Meteora",
        address: pool.address,
        tokenAMint: pool.token_x.address,
        tokenBMint: pool.token_y.address,
        tokenAName: pool.token_x.name,
        tokenBName: pool.token_y.name,
        tokenASymbol: pool.token_x.symbol,
        tokenBSymbol: pool.token_y.symbol,
        liquidity: pool.tvl,
        volume24h: pool.volume?.["24h"] ?? 0,
        // base_fee_pct is a percentage (e.g. 0.04 = 0.04%); store as a fraction.
        fee: (pool.pool_config?.base_fee_pct ?? 0) / 100,
        poolType: "dlmm",
    }));
}
