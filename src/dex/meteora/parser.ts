import { Pool } from "../../types";

export interface MeteoraApiPool {
    address: string;
    name: string;
    mint_x: string;
    mint_y: string;
    liquidity: string;
    trade_volume_24h: number;
    base_fee_percentage: string;
}

export function meteoraPoolParser(data: MeteoraApiPool[]): Pool[] {
    return data.map((pool) => {
        const symbols = pool.name.split("-");
        return {
            dex: "Meteora",
            address: pool.address,
            tokenAMint: pool.mint_x,
            tokenBMint: pool.mint_y,
            tokenAName: symbols[0] || "",
            tokenBName: symbols[1] || "",
            tokenASymbol: symbols[0] || "",
            tokenBSymbol: symbols[1] || "",
            liquidity: parseFloat(pool.liquidity),
            volume24h: pool.trade_volume_24h,
            fee: parseFloat(pool.base_fee_percentage) / 100,
            poolType: "dlmm",
        };
    });
}
