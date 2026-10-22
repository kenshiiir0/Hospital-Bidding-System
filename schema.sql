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

-- PS-PhilGEPS (philgeps.gov.ph): the last Sync's result, so every computer and the deployed dashboard
-- show the same data. One row ('latest'): lists = { bidMatch, opportunities, awards } as read by
-- ps-philgeps-sync.js ({ label, headers, rows: [{ cells, links }], pages }), notices = { ref: { matched,
-- documents: [{ name, size, url, path }], errors } }. Written with the secret key (tools/ps-publish.js).
CREATE TABLE IF NOT EXISTS ps_philgeps_snapshot (
    id TEXT PRIMARY KEY,
    synced_at TIMESTAMPTZ NOT NULL,
    lists JSONB NOT NULL,
    notices JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ps_philgeps_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dashboard can read" ON ps_philgeps_snapshot;
CREATE POLICY "dashboard can read" ON ps_philgeps_snapshot FOR SELECT TO authenticated
    USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ps_philgeps_snapshot FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ps_philgeps_snapshot FROM authenticated;

-- PS-PhilGEPS bid documents (PDFs), private bucket: <ref>/<file name>. Team members may read (the
-- dashboard makes short-lived signed links); uploads use the secret key.
INSERT INTO storage.buckets (id, name, public) VALUES ('ps-documents', 'ps-documents', false)
ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS "team can read ps documents" ON storage.objects;
CREATE POLICY "team can read ps documents" ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'ps-documents' AND coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));

-- PhilGEPS bid documents downloaded by Sync, private bucket: <ref>/<file name>. Team members may read (the
-- dashboard makes short-lived signed links); uploads use the secret key (documents-storage.js).
INSERT INTO storage.buckets (id, name, public) VALUES ('philgeps-documents', 'philgeps-documents', false)
ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS "team can read philgeps documents" ON storage.objects;
CREATE POLICY "team can read philgeps documents" ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'philgeps-documents' AND coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));

-- PS-PhilGEPS log-in session (cookies) shared by the deployed dashboard's Sync and every computer.
-- Saved by `node ps-philgeps-session.js --connect` (a person ticks the captcha) and refreshed by each
-- Sync. Private: no policies, so only the secret key (server side) can read or write it.
CREATE TABLE IF NOT EXISTS ps_philgeps_session (
    id TEXT PRIMARY KEY,
    cookies JSONB NOT NULL,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ps_philgeps_session ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ps_philgeps_session FROM anon, authenticated;

-- PS-PhilGEPS Sync status shown to the whole team (row 'latest'): status idle | running | success | failed,
-- connected_at = when the saved session was made (null = not connected, a person must Connect).
CREATE TABLE IF NOT EXISTS ps_sync_status (
    id TEXT PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'idle',
    percent INT NOT NULL DEFAULT 0,
    stage TEXT,
    error TEXT,
    started_by TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    connected_at TIMESTAMPTZ
);
ALTER TABLE ps_sync_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dashboard can read" ON ps_sync_status;
CREATE POLICY "dashboard can read" ON ps_sync_status FOR SELECT TO authenticated
    USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ps_sync_status FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ps_sync_status FROM authenticated;
INSERT INTO ps_sync_status (id) VALUES ('latest') ON CONFLICT (id) DO NOTHING;

-- What was read in each PS-PhilGEPS tender's bid documents (frontend/src/lib/psDocs.mjs, free text
-- rules, run by the keep-alive call): result = { bid_data_sheet: { prebid_conference, bid_opening,
-- bid_submission_deadline, delivery_period, bid_validity, bid_security } (passages as written),
-- items: [{ our_products[], item_no, quantity, unit, unit_price, total, description, line, context,
-- source }] }. documents_key changes with the documents or the rules version, which makes it read again;
-- a failed reading has no key and is tried again. Team read only; written with the secret key.
CREATE TABLE IF NOT EXISTS ps_tender_analysis (
    ref TEXT PRIMARY KEY,
    status VARCHAR(20) NOT NULL,          -- done | failed | skipped
    result JSONB,
    documents_read JSONB,                 -- [{ name, kind: text | scanned, pages }]
    documents_key TEXT,
    error TEXT,
    model TEXT,                           -- rules version that read it
    analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ps_tender_analysis DROP COLUMN IF EXISTS attempts;
ALTER TABLE ps_tender_analysis DROP COLUMN IF EXISTS input_tokens;
ALTER TABLE ps_tender_analysis DROP COLUMN IF EXISTS output_tokens;
ALTER TABLE ps_tender_analysis ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dashboard can read" ON ps_tender_analysis;
CREATE POLICY "dashboard can read" ON ps_tender_analysis FOR SELECT TO authenticated
    USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ps_tender_analysis FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ps_tender_analysis FROM authenticated;
