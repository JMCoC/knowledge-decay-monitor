import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const cli = resolve(root, "node_modules/supabase/dist/supabase.js");
const outputPath = resolve(root, "src/types/database.ts");

let generated;
try {
  generated = execFileSync(process.execPath, [cli, "gen", "types", "typescript", "--local"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
} catch {
  console.error("Could not generate database types from the local Supabase schema.");
  process.exit(1);
}

const normalize = (text) => text.replace(/\r\n/g, "\n");
let checkedIn;
try {
  checkedIn = readFileSync(outputPath, "utf8");
} catch {
  console.error("The generated database type file is missing.");
  process.exit(1);
}

if (normalize(generated) !== normalize(checkedIn)) {
  console.error("src/types/database.ts does not match the local Supabase schema. Regenerate it and review the diff.");
  process.exit(1);
}

console.log("Generated database types match the local Supabase schema.");
