import { ApiV3PoolInfoItem } from "@raydium-io/raydium-sdk-v2";
import { Pool } from "../../types";

export function parseRaydiumPool(data: ApiV3PoolInfoItem[]): Pool[] {
    return data.map((pool) => {
        let normalizedType = "amm"; // Default fallback
        const programId = pool.programId.toString();

        if (programId === "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK") {
            normalizedType = "clmm";
        } else if (programId === "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C") {
            normalizedType = "cpmm";
        } else if (
            programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" ||
            programId === "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h"
        ) {
            normalizedType = "amm";
        } else {
             // Fallback to evaluating `pool.type`
             const rawType = pool.type.toLowerCase();
             if (rawType.includes("concentrated") || rawType.includes("clmm")) {
                normalizedType = "clmm";
            } else if (rawType.includes("cpmm")) {
                normalizedType = "cpmm";
            }
        }

        return {
            dex: "Raydium",
            address: pool.id,
            tokenAMint: pool.mintA.address,
            tokenBMint: pool.mintB.address,
            tokenAName: pool.mintA.name,
            tokenBName: pool.mintB.name,
            tokenASymbol: pool.mintA.symbol,
            tokenBSymbol: pool.mintB.symbol,
            liquidity: pool.tvl,
            volume24h: pool.day.volume,
            fee: pool.feeRate,
            poolType: normalizedType,
        };
    });
}
