import "dotenv/config";
import pgPool from "../database";
import { RaydiumDex, WhirlpoolDex, MeteoraDex } from "../dex";

const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const adapters: Record<string, any> = {
    Raydium: new RaydiumDex({ rpcUrl }),
    Whirlpool: new WhirlpoolDex({ rpcUrl }),
    Meteora: new MeteoraDex({ rpcUrl })
};

export async function fetchPoolPrice(poolAddress: string): Promise<void> {
    if (!poolAddress) {
        console.error("❌  Please provide a pool address as a parameter.");
        return;
    }

    console.log(`🔍  Looking up pool ${poolAddress} in the database...`);

    try {
        const query = `
            SELECT dex, pool_type, token_a_mint, token_b_mint, token_a_symbol, token_b_symbol
            FROM pools
            WHERE address = $1
            LIMIT 1;
        `;
        const res = await pgPool.query(query, [poolAddress]);

        if (res.rows.length === 0) {
            console.error(`⚠️  Pool ${poolAddress} not found in the database.`);
            return;
        }

        const poolData = res.rows[0];
        console.log(`✅  Found pool in DB! DEX: ${poolData.dex}, Type: ${poolData.pool_type || "N/A"}`);
        console.log(`🪙  Tokens: ${poolData.token_a_symbol || poolData.token_a_mint} / ${poolData.token_b_symbol || poolData.token_b_mint}`);

        const adapter = adapters[poolData.dex];
        if (!adapter) {
            console.error(`❌  No adapter found for DEX: ${poolData.dex}.`);
            return;
        }

        console.log(`📡  Fetching current price from ${poolData.dex}...`);

        const priceData = await adapter.getPoolPrice(poolAddress, poolData.pool_type);

        console.log(`\n💰  **Current Pool Price**`);
        console.log(`-----------------------------------------------`);
        console.log(`DEX:         ${priceData.dex}`);
        console.log(`Pool:        ${priceData.poolAddress}`);
        console.log(`Token A:     ${priceData.tokenAMint}`);
        console.log(`Token B:     ${priceData.tokenBMint}`);
        console.log(`Price:       ${priceData.price.toPrecision(7)} (Token B per Token A)`);
        console.log(`Fetched at:  ${priceData.fetchedAt}`);
        console.log(`-----------------------------------------------`);

    } catch (error) {
        console.error("❌  Error fetching pool price:", error instanceof Error ? error.message : error);
    } finally {
        // Close db connection if run as standalone script
        if (require.main === module) {
            await pgPool.end();
            process.exit(0);
        }
    }
}

// Allow running via CLI: npx tsx src/entries/pool-price.ts <poolAddress>
if (require.main === module) {
    const args = process.argv.slice(2);
    const poolAddressArg = args[0];
    fetchPoolPrice(poolAddressArg);
}
