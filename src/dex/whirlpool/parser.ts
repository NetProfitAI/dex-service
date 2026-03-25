import { Pool } from "../../types";

export interface WhirlpoolApiPool {
    address: string;
    tokenA: {
        mint: string;
        symbol: string;
        name: string;
        decimals: number;
    };
    tokenB: {
        mint: string;
        symbol: string;
        name: string;
        decimals: number;
    };
    tvl: number;
    volume?: {
        day: number;
    };
    lpFeeRate: number;
}

export interface WhirlpoolApiResponse {
    whirlpools: WhirlpoolApiPool[];
}

export function parseWhirlpoolPools(data: WhirlpoolApiPool[]): Pool[] {
    return data.map((pool) => ({
        dex: "Whirlpool",
        address: pool.address,
        tokenAMint: pool.tokenA.mint,
        tokenBMint: pool.tokenB.mint,
        tokenAName: pool.tokenA.name,
        tokenBName: pool.tokenB.name,
        tokenASymbol: pool.tokenA.symbol,
        tokenBSymbol: pool.tokenB.symbol,
        liquidity: pool.tvl,
        volume24h: pool.volume?.day || 0,
        fee: pool.lpFeeRate,
        poolType: "clmm",
    }));
}
