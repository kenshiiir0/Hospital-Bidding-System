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

-- PhilGEPS Sync relayed from any dashboard to the team computer that can run it (Chrome + the PhilGEPS
-- log-in): a dashboard sets requested_at, the team computer's dashboard takes it (handled_at), runs the
-- Sync and mirrors its progress in job; worker_seen_at = that computer's last check (frontend/src/lib/
-- philgepsRelay.js). Private: no policies, only the secret key (server side).
CREATE TABLE IF NOT EXISTS philgeps_sync_relay (
    id TEXT PRIMARY KEY,
    job JSONB,
    requested_at TIMESTAMPTZ,
    requested_by TEXT,
    handled_at TIMESTAMPTZ,
    worker_seen_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE philgeps_sync_relay ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON philgeps_sync_relay FROM anon, authenticated;
INSERT INTO philgeps_sync_relay (id) VALUES ('latest') ON CONFLICT (id) DO NOTHING;

-- PhilGEPS (notices.philgeps.gov.ph) log-in session of the server-side Sync (frontend/src/lib/philgepsSync.mjs):
-- saved the moment the log-in is sent, removed once the log-out is confirmed. A row left behind (round cut
-- off) is logged out by the 5-minute clean-up (/api/ps-keepalive → sweepSession). Private: secret key only.
CREATE TABLE IF NOT EXISTS philgeps_session (
    id TEXT PRIMARY KEY,
    cookies JSONB NOT NULL,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE philgeps_session ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON philgeps_session FROM anon, authenticated;
-- Set when the log-out was confirmed: the row (cookies) is kept an hour so the 5-minute clean-up can check with
-- the session's own cookies that PhilGEPS really closed it, and log out again if not
ALTER TABLE philgeps_session ADD COLUMN IF NOT EXISTS logged_out_at TIMESTAMPTZ;

-- Every log-in the system makes to PhilGEPS ('philgeps') and PS-PhilGEPS ('ps-philgeps'), read by
-- frontend/src/lib/loginGuard.mjs to keep log-ins few (no lock-out for suspicious activity).
-- outcome: started | ok | rejected | busy | error | cancelled. Private: secret key only.
CREATE TABLE IF NOT EXISTS login_attempts (
    id BIGSERIAL PRIMARY KEY,
    site TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT,
    source TEXT,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_site_at ON login_attempts (site, at DESC);
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON login_attempts FROM anon, authenticated;

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

-- Hospitals' own websites, shown under the hospital name in View details. agency_key = the agency name
-- in capitals with punctuation removed (PhilGEPS and PS-PhilGEPS spell names slightly differently).
-- procurement_pages = [{ label, url }]: pages listing their Invitations to Bid / RFQs, checked by
-- frontend/src/lib/hospitals.mjs. Team members may add and edit hospitals from the dashboard.
CREATE TABLE IF NOT EXISTS hospitals (
    agency_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    website TEXT,
    procurement_pages JSONB NOT NULL DEFAULT '[]',
    note TEXT,                            -- e.g. "site under maintenance"
    checked_at TIMESTAMPTZ,
    check_error TEXT,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE hospitals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dashboard can read" ON hospitals;
CREATE POLICY "dashboard can read" ON hospitals FOR SELECT TO authenticated
    USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
DROP POLICY IF EXISTS "team can add" ON hospitals;
CREATE POLICY "team can add" ON hospitals FOR INSERT TO authenticated
    WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
DROP POLICY IF EXISTS "team can edit" ON hospitals;
CREATE POLICY "team can edit" ON hospitals FOR UPDATE TO authenticated
    USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false))
    WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
REVOKE ALL ON hospitals FROM anon;
REVOKE DELETE, TRUNCATE ON hospitals FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON hospitals TO authenticated;

-- Postings found on hospitals' procurement pages (links only, nothing downloaded). first_seen_at = the
-- day the check first saw it (the pages show no dates), used for "this month".
CREATE TABLE IF NOT EXISTS hospital_postings (
    url TEXT PRIMARY KEY,
    agency_key TEXT NOT NULL REFERENCES hospitals(agency_key) ON DELETE CASCADE,
    title TEXT NOT NULL,
    page_url TEXT NOT NULL,
    page_label TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hospital_postings_agency ON hospital_postings (agency_key, first_seen_at DESC);
ALTER TABLE hospital_postings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dashboard can read" ON hospital_postings;
CREATE POLICY "dashboard can read" ON hospital_postings FOR SELECT TO authenticated
    USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
REVOKE ALL ON hospital_postings FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON hospital_postings FROM authenticated;
-- page_order: position on the hospital's page (the pages list newest first). baseline: already on the
-- page at the first check (the pages show no dates), so it never counts as new.
ALTER TABLE hospital_postings ADD COLUMN IF NOT EXISTS page_order INT;
ALTER TABLE hospital_postings ADD COLUMN IF NOT EXISTS baseline BOOLEAN NOT NULL DEFAULT false;

-- Our products: the B2B price list (B2B PRICELIST AS OF 10_10_2026.xlsx) and the team's PRODUCT LIST (tab of
-- PHILGEPS OPPORTUNITY.xlsx), the only source of what tenders are screened for: molecule AND dosage
-- (frontend/src/lib/products.mjs). One row
-- per generic / brand / dosage. Rows come from the list, or from the dashboard's Add Molecule (POST /api/products,
-- secret key). Team members may read.
CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY,
    generic_name TEXT NOT NULL,
    brand_name TEXT NOT NULL,
    dosage TEXT NOT NULL,
    account TEXT,
    classification TEXT,
    dosage_form TEXT,
    unit TEXT,
    pack_size TEXT,
    source TEXT NOT NULL DEFAULT 'added',     -- b2b-pricelist | product-list | added
    added_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (generic_name, brand_name, dosage)
);
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dashboard can read" ON products;
CREATE POLICY "dashboard can read" ON products FOR SELECT TO authenticated
    USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
REVOKE ALL ON products FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON products FROM authenticated;
-- Archive (Product List page, PATCH /api/products): an archived product is kept but no longer screened for;
-- Restore brings it back. The matcher only reads rows with archived_at NULL (loadProducts).
ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_by TEXT;

-- Award notices "Pending for Acceptance" emailed to the hospital's representative by the PS-PhilGEPS Sync
-- (frontend/src/lib/awardNotify.mjs, routing in awardRouting.mjs): one row per award; status sent | failed
-- (failed is tried again, up to 3 attempts). The Award Notices page shows who was told.
CREATE TABLE IF NOT EXISTS award_notifications (
    award_no TEXT PRIMARY KEY,
    line_item TEXT,
    agency TEXT,
    hospital_no INT,                          -- number on the served list of hospitals; NULL = not on it
    recipients TEXT[] NOT NULL DEFAULT '{}',
    status VARCHAR(20) NOT NULL,
    error TEXT,
    attempts INT NOT NULL DEFAULT 0,
    sent_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE award_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dashboard can read" ON award_notifications;
CREATE POLICY "dashboard can read" ON award_notifications FOR SELECT TO authenticated
    USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
REVOKE ALL ON award_notifications FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON award_notifications FROM authenticated;

-- Screened Tenders (dashboard page /screened): tenders a team member picked with "Add to Screened" in View
-- details on the PhilGEPS Dashboard or PS-PhilGEPS Bid Match (frontend/src/lib/screened.js). The Excel export
-- comes from this list. tender = the tender in export shape when it was added (lib/opportunityWorkbook.js),
-- used for the list and when the tender is no longer in the live data. added_by is filled from the sign-in.
CREATE TABLE IF NOT EXISTS screened_tenders (
    source TEXT NOT NULL CHECK (source IN ('philgeps', 'ps')),
    ref TEXT NOT NULL,
    title TEXT,
    tender JSONB NOT NULL,
    added_by TEXT DEFAULT (auth.jwt() ->> 'email'),
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source, ref)
);
ALTER TABLE screened_tenders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dashboard can read" ON screened_tenders;
CREATE POLICY "dashboard can read" ON screened_tenders FOR SELECT TO authenticated
    USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
DROP POLICY IF EXISTS "team can add" ON screened_tenders;
CREATE POLICY "team can add" ON screened_tenders FOR INSERT TO authenticated
    WITH CHECK (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
DROP POLICY IF EXISTS "team can remove" ON screened_tenders;
CREATE POLICY "team can remove" ON screened_tenders FOR DELETE TO authenticated
    USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
REVOKE ALL ON screened_tenders FROM anon;
REVOKE UPDATE, TRUNCATE ON screened_tenders FROM authenticated;
GRANT SELECT, INSERT, DELETE ON screened_tenders TO authenticated;

-- Reading scanned documents (OCR), row 'latest'. Layer 1: the GitHub Actions job (.github/workflows/ocr.yml,
-- tools/ocr-job.mjs) reads them with tesseract every hour; layer 2: Google Cloud Vision from the deployed
-- server (frontend/src/lib/ocrVision.mjs) for documents still waiting after 6 hours, at most
-- VISION_MONTHLY_PAGES pages a month (below Google's free amount). waiting / oldest_waiting_since: scanned
-- documents not read yet (the dashboard warns when one has waited more than 6 hours). Team read only.
CREATE TABLE IF NOT EXISTS ocr_status (
    id TEXT PRIMARY KEY,
    github_last_run_at TIMESTAMPTZ,
    github_last_result TEXT,
    vision_last_run_at TIMESTAMPTZ,
    vision_last_result TEXT,
    vision_month TEXT,                    -- 'YYYY-MM' the page count below belongs to
    vision_pages INT NOT NULL DEFAULT 0,
    waiting INT NOT NULL DEFAULT 0,
    oldest_waiting_since TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ocr_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dashboard can read" ON ocr_status;
CREATE POLICY "dashboard can read" ON ocr_status FOR SELECT TO authenticated
    USING (coalesce((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ocr_status FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ocr_status FROM authenticated;
INSERT INTO ocr_status (id) VALUES ('latest') ON CONFLICT (id) DO NOTHING;
-- github_requested_at: a Sync asked GitHub to run the OCR job now (lib/ocrTrigger.mjs);
-- github_running_since: the job is reading (set at its start, cleared at its end). The dashboard shows
-- "Reading scanned documents" while either is recent.
ALTER TABLE ocr_status ADD COLUMN IF NOT EXISTS github_requested_at TIMESTAMPTZ;
ALTER TABLE ocr_status ADD COLUMN IF NOT EXISTS github_running_since TIMESTAMPTZ;

-- Live updates (Supabase Realtime) for the PS-PhilGEPS pages and the OCR bar: the dashboards change the
-- moment a Sync finishes, its documents are read, or scanned documents are read with OCR, without a refresh
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['ps_philgeps_snapshot', 'ps_tender_analysis', 'ps_sync_status', 'ocr_status'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = t) THEN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
        END IF;
    END LOOP;
END $$;

-- PS-PhilGEPS reconnect from any device (lib/psCloudConnect.mjs, tools/ps-connect-cloud.js): the cloud log-in's
-- picture and the person's clicks travel on a private Realtime channel "ps-connect:<id>". Only signed-in team
-- accounts (app_metadata.team) may watch it or send clicks; the cloud job uses the secret key.
DROP POLICY IF EXISTS "team watches ps-connect" ON realtime.messages;
CREATE POLICY "team watches ps-connect" ON realtime.messages FOR SELECT TO authenticated
    USING (realtime.topic() LIKE 'ps-connect:%' AND COALESCE((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));
DROP POLICY IF EXISTS "team clicks ps-connect" ON realtime.messages;
CREATE POLICY "team clicks ps-connect" ON realtime.messages FOR INSERT TO authenticated
    WITH CHECK (realtime.topic() LIKE 'ps-connect:%' AND COALESCE((auth.jwt() -> 'app_metadata' ->> 'team')::boolean, false));

-- The month's bid-document downloads out of Storage by the readers (frontend/src/lib/usageMeter.mjs): they stop at
-- 2.5 GB a month so the free plan's 5 GB of downloads is never used up (it was on 2026-11-03). Server only.
CREATE TABLE IF NOT EXISTS usage_meter (
    month TEXT PRIMARY KEY,
    read_bytes BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE usage_meter ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION add_read_bytes(m TEXT, b BIGINT) RETURNS BIGINT LANGUAGE sql AS $$
    INSERT INTO usage_meter (month, read_bytes) VALUES (m, b)
    ON CONFLICT (month) DO UPDATE SET read_bytes = usage_meter.read_bytes + EXCLUDED.read_bytes, updated_at = now()
    RETURNING read_bytes;
$$;
REVOKE EXECUTE ON FUNCTION add_read_bytes(TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
