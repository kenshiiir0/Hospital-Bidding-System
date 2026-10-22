// Runs once when the dashboard server starts: the hourly automatic PhilGEPS fetch lives here, so it runs
// whenever the dashboard does (no separate scheduler process needed). It also brings the Supabase database
// up to date with schema.sql (tools/apply-schema.js; does nothing when schema.sql is unchanged).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const { applySchemaIfChanged } = await import('./lib/schema');
  applySchemaIfChanged();
  const { startScheduler } = await import('./lib/fetchJobs');
  startScheduler();
}
