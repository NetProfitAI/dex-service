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
