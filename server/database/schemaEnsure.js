/**
 * Guard for the boot-time, idempotent schema routines (server/database/ensure*.js).
 *
 * Long-running servers (local dev, Render) run them on every boot. On a
 * serverless runtime (Vercel) a cold start would otherwise fire every routine
 * concurrently at PostgreSQL, exhausting the connection pool and timing out the
 * very request that triggered the cold start, so they are skipped there.
 *
 * Force them on with RUN_SCHEMA_ENSURE=1 (useful for a brand new database) or
 * off with RUN_SCHEMA_ENSURE=0.
 */
function shouldRunSchemaEnsure() {
  if (process.env.RUN_SCHEMA_ENSURE === '1') return true;
  if (process.env.RUN_SCHEMA_ENSURE === '0') return false;
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  return !isServerless;
}

module.exports = { shouldRunSchemaEnsure };
