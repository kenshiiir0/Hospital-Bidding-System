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
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Migration: item list from the tender's detail page and which of our products it mentions (molecules.json)
ALTER TABLE philgeps_opportunities ADD COLUMN IF NOT EXISTS items_text TEXT;
ALTER TABLE philgeps_opportunities ADD COLUMN IF NOT EXISTS matched_molecules TEXT[] NOT NULL DEFAULT '{}';

-- Migration: notice details shown in the dashboard's tender panel (procurement mode, contact person, ...)
ALTER TABLE philgeps_opportunities ADD COLUMN IF NOT EXISTS details JSONB;

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

-- Security: the dashboard uses the public (publishable) key, so that key may only read, and only for a
-- signed-in team member: an account whose app_metadata has team = true. Only the secret key can set
-- app_metadata (tools/add-user.js does), so an account someone signs up for themselves reads nothing.
-- Writes come from scraper.js with the secret key, which bypasses these rules.
ALTER TABLE philgeps_opportunities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dashboard can read" ON philgeps_opportunities;
CREATE POLICY "dashboard can read" ON philgeps_opportunities FOR SELECT TO authenticated
    USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON philgeps_opportunities FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON philgeps_opportunities FROM authenticated;

-- History page: one row per thing that happened in the system (for now, each scraper run).
-- details holds the event's numbers and the reference numbers of the tenders it added.
CREATE TABLE IF NOT EXISTS activity_log (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    event VARCHAR(50) NOT NULL,      -- 'scrape'
    status VARCHAR(20) NOT NULL,     -- 'success' | 'failed'
    trigger VARCHAR(20),             -- 'dashboard' | 'schedule' | 'manual'
    summary TEXT,
    details JSONB
);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dashboard can read" ON activity_log;
CREATE POLICY "dashboard can read" ON activity_log FOR SELECT TO authenticated
    USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON activity_log FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON activity_log FROM authenticated;

-- Broadcast new history entries to the dashboard via Supabase Realtime
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'activity_log'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE activity_log;
    END IF;
END $$;
