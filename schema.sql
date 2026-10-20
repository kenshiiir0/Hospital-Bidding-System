CREATE TABLE IF NOT EXISTS philgeps_opportunities (
    id SERIAL PRIMARY KEY,
    ref_no VARCHAR(50) UNIQUE,
    publish_date DATE,
    closing_date TIMESTAMP,
    title TEXT,
    category VARCHAR(100) DEFAULT 'Drugs and Medicines',
    procuring_entity TEXT,
    abc_amount NUMERIC(15, 2),
    detail_link TEXT UNIQUE,
    status VARCHAR(50) DEFAULT 'NEW',
    items_text TEXT,
    matched_molecules TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Migration: item list from the tender's detail page and which of our products it mentions (molecules.json)
ALTER TABLE philgeps_opportunities ADD COLUMN IF NOT EXISTS items_text TEXT;
ALTER TABLE philgeps_opportunities ADD COLUMN IF NOT EXISTS matched_molecules TEXT[] NOT NULL DEFAULT '{}';

-- Migration for tables created before detail_link was UNIQUE (the scraper upserts on ref_no)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'philgeps_opportunities_detail_link_key'
    ) THEN
        ALTER TABLE philgeps_opportunities
            ADD CONSTRAINT philgeps_opportunities_detail_link_key UNIQUE (detail_link);
    END IF;
END $$;

-- Broadcast INSERTs to the dashboard via Supabase Realtime
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'philgeps_opportunities'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE philgeps_opportunities;
    END IF;
END $$;
