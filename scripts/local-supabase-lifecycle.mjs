import {
  LOCAL_API_URL,
  readLocalSupabaseRuntime,
  runLocalSupabaseLifecycle,
} from "./local-supabase.mjs";

const command = process.argv[2];
if (command !== "start" && command !== "stop") {
  console.error("Usage: node scripts/local-supabase-lifecycle.mjs <start|stop>");
  process.exit(2);
}

try {
  runLocalSupabaseLifecycle(command);
  if (command === "start") {
    const runtime = readLocalSupabaseRuntime();
    if (runtime.apiUrl !== LOCAL_API_URL) throw new Error("Unexpected local API URL.");
    console.log("Local Supabase is ready on the configured loopback URL.");
  } else {
    console.log("Local Supabase stopped.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local Supabase lifecycle failed.");
  process.exitCode = 1;
}
