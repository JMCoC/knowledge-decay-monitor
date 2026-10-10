// Compatibility entry for the former HTTP/Edge processing check.
// The integration test now starts the real durable worker and pinned model itself.
import { runWithLocalSupabase } from "./with-local-supabase.mjs";
process.exitCode = runWithLocalSupabase({selected:"integration",forwardedArgs:["tests/integration/ingestion-worker.test.ts"]});
