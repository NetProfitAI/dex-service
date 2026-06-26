CREATE TABLE IF NOT EXISTS pools (
    id SERIAL PRIMARY KEY,
    dex VARCHAR(50) NOT NULL,
    address VARCHAR(100) NOT NULL,
    token_a_mint VARCHAR(100) NOT NULL,
    token_b_mint VARCHAR(100) NOT NULL,
    token_a_name VARCHAR(255),
    token_b_name VARCHAR(255),
    token_a_symbol VARCHAR(255),
    token_b_symbol VARCHAR(255),
    liquidity NUMERIC,
    volume_24h NUMERIC,
    fee NUMERIC,
    pool_type VARCHAR(50),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(dex, address)
);

CREATE INDEX IF NOT EXISTS idx_pools_tokens ON pools(token_a_mint, token_b_mint);
CREATE INDEX IF NOT EXISTS idx_pools_dex ON pools(dex);

-- Arbitrage opportunities detected by the scanner.
-- One row per detected cross-DEX opportunity, with the implicated pools and the route.
-- NOTE: IF NOT EXISTS makes this idempotent — it never drops or alters existing tables/data.
CREATE TABLE IF NOT EXISTS arbitrage_opportunities (
    id SERIAL PRIMARY KEY,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    detected_date DATE NOT NULL DEFAULT CURRENT_DATE,
    detected_hour SMALLINT NOT NULL DEFAULT EXTRACT(HOUR FROM now()),

    -- The pair being arbitraged
    token_a_mint VARCHAR(100) NOT NULL,
    token_b_mint VARCHAR(100) NOT NULL,
    token_a_symbol VARCHAR(255),
    token_b_symbol VARCHAR(255),

    -- The route: buy low on one DEX/pool, sell high on another
    route VARCHAR(120) NOT NULL,            -- e.g. "Raydium -> Whirlpool"
    buy_dex VARCHAR(50) NOT NULL,
    buy_pool VARCHAR(100) NOT NULL,
    buy_price NUMERIC NOT NULL,
    sell_dex VARCHAR(50) NOT NULL,
    sell_pool VARCHAR(100) NOT NULL,
    sell_price NUMERIC NOT NULL,

    -- Economics of the opportunity
    gross_pct NUMERIC,
    fee_pct NUMERIC,
    impact_pct NUMERIC,
    net_pct NUMERIC,
    trade_usd NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_arb_detected_at ON arbitrage_opportunities(detected_at);
CREATE INDEX IF NOT EXISTS idx_arb_date_hour ON arbitrage_opportunities(detected_date, detected_hour);
CREATE INDEX IF NOT EXISTS idx_arb_tokens ON arbitrage_opportunities(token_a_mint, token_b_mint);
