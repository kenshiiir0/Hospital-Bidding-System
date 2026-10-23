// Runs once when the dashboard server starts: brings the Supabase database up to date with schema.sql
// (tools/apply-schema.js; does nothing when schema.sql is unchanged). The hourly PhilGEPS update no longer
// runs here: Supabase calls /api/philgeps-update on the deployed server (tools/setup-schedules.js).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const { applySchemaIfChanged } = await import('./lib/schema');
  applySchemaIfChanged();
}
