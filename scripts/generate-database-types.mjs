import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const cli = resolve(root, "node_modules/supabase/dist/supabase.js");
const outputPath = resolve(root, "src/types/database.ts");

let generated;
try {
  generated = execFileSync(process.execPath, [
    cli,
    "gen",
    "types",
    "typescript",
    "--local",
    "--schema",
    "public",
  ], {
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

const withoutBom = generated.charCodeAt(0) === 0xfeff ? generated.slice(1) : generated;
writeFileSync(outputPath, withoutBom.replace(/\r\n/g, "\n"), { encoding: "utf8" });
console.log("Generated src/types/database.ts from the local Supabase schema.");
