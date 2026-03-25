import "dotenv/config";
import { RaydiumDex, WhirlpoolDex, MeteoraDex } from "../dex";
import type { DexConfig } from "../types";
import { savePools, truncatePools } from "../database";

// ─── Configuration ────────────────────────────────────────────────────────────

const config: DexConfig = {
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
};

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function syncPools(): Promise<void> {
    console.log("🚀  DEX Multi-Pool Service starting…\n");

    // 1. Truncate table to ensure consistency (remove old/stale pools)
    try {
        await truncatePools();
    } catch (err) {
        console.error("❌ Failed to truncate pools. Make sure to run 'npm run dev jobs init-db' first.");
        return;
    }

    const adapters = [
        new RaydiumDex(config),
        new WhirlpoolDex(config),
        new MeteoraDex(config),
    ];

    // 2. Fetch and Store Pools
    for (const adapter of adapters) {
        console.log(`\n📂  Syncing pools for ${adapter.name}…`);
        try {
            const pools = await adapter.getPoolList();
            console.log(`✅  Retrieved ${pools.length} pools from ${adapter.name}.`);

            await savePools(pools);
        } catch (err) {
            console.error(`❌  Failed to sync pools for ${adapter.name}:`, err);
        }
    }

    console.log("\n✨ Sync complete.");
}

export default syncPools;
