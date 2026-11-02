import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = join(ROOT, "supabase/functions/dispatch-notifications/index.ts");
const CONFIG = join(ROOT, "supabase/functions/dispatch-notifications/deno.json");
const FROM_SPECIFIER = /^\s*(?:import|export)\s+[\s\S]*?\sfrom\s*["']([^"']+)["']\s*;/gm;
const ALLOWED_PACKAGES = new Set(["@sentry/deno", "@supabase/supabase-js", "zod"]);

function collectEdgeGraph(): { files: string[]; violations: string[] } {
  const files: string[] = [];
  const violations: string[] = [];
  const visited = new Set<string>();
  const pending = [ENTRY];

  while (pending.length > 0 && existsSync(ENTRY)) {
    const file = pending.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    files.push(file);
    const source = readFileSync(file, "utf8");

    for (const match of source.matchAll(FROM_SPECIFIER)) {
      const specifier = match[1] as string;
      const line = source.slice(0, match.index).split("\n").length;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        if (!specifier.endsWith(".ts")) {
          violations.push(`${file}:${line} -> extensionless ${specifier}`);
          continue;
        }
        const child = resolve(dirname(file), specifier);
        if (!existsSync(child)) violations.push(`${file}:${line} -> missing ${specifier}`);
        else pending.push(child);
      } else if (specifier.startsWith("node:") || /@sentry\/(?:nextjs|node)|server-only/.test(specifier)) {
        violations.push(`${file}:${line} -> forbidden ${specifier}`);
      } else if (!ALLOWED_PACKAGES.has(specifier)) {
        violations.push(`${file}:${line} -> unmapped ${specifier}`);
      }
    }
  }

  return { files, violations };
}

describe("notification Deno bundle imports", () => {
  it("has a dispatcher Edge Function entry point", () => {
    expect(existsSync(ENTRY)).toBe(true);
  });

  it("keeps the reachable graph in Deno-compatible modules and pinned packages", () => {
    if (!existsSync(ENTRY)) return;
    const { files, violations } = collectEdgeGraph();
    const deno = JSON.parse(readFileSync(CONFIG, "utf8")) as { imports: Record<string, string> };

    expect(files.length).toBeGreaterThan(5);
    expect(violations).toEqual([]);
    expect(deno.imports).toMatchObject({
      "@sentry/deno": "npm:@sentry/deno@10.75.0",
      "@supabase/supabase-js": "npm:@supabase/supabase-js@2.117.2",
      zod: "npm:zod@4.6.5",
    });
  });
});
