import { createClient } from '@supabase/supabase-js';

// One browser client for every page (publishable key: read-only, see schema.sql)
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
