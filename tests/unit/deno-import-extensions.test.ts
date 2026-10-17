import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const ALLOWED_DIRS = [
  "supabase/functions/analyze",
  "src/modules/analysis/worker",
  "src/modules/analysis",
  "src/types",
  "supabase/functions/analyze/_test_doubles",
].map((dir) => join(REPO_ROOT, dir));

const ENTRY = join(REPO_ROOT, "supabase/functions/analyze/index.ts");

// Matches `from "…"` and `from '…'` on import and re-export statements
// (value and type imports alike: Deno resolves both at graph build).
// [\s\S] so multiline import blocks are covered.
const FROM_SPECIFIER =
  /^\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/gm;

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function withinAllowedDirs(absolutePath: string): boolean {
  return ALLOWED_DIRS.some(
    (dir) =>
      absolutePath === dir || absolutePath.startsWith(`${dir}/`),
  );
}

function resolveSpecifier(
  fromFile: string,
  specifier: string,
): string | null {
  if (!isRelative(specifier)) return null;
  if (specifier.endsWith(".ts")) {
    return resolve(dirname(fromFile), specifier);
  }
  for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
    const absolute = resolve(dirname(fromFile), candidate);
    if (existsSync(absolute)) return absolute;
  }
  return null;
}

function collectGraph(): { files: string[]; violations: string[] } {
  const files: string[] = [];
  const violations: string[] = [];
  const visited = new Set<string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    files.push(file);
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(FROM_SPECIFIER)) {
      const specifier = match[1] as string;
      if (!isRelative(specifier)) continue;
      const line = content.slice(0, match.index).split("\n").length;
      if (!specifier.endsWith(".ts")) {
        violations.push(`${file}:${line} -> ${specifier}`);
        continue;
      }
      const absolute = resolveSpecifier(file, specifier);
      if (
        absolute !== null &&
        absolute.endsWith(".ts") &&
        withinAllowedDirs(absolute) &&
        existsSync(absolute)
      ) {
        queue.push(absolute);
      }
    }
  }
  return { files, violations };
}

describe("deno import extensions", () => {
  it("reaches the whole Edge graph", () => {
    const { files } = collectGraph();
    expect(files.length).toBeGreaterThanOrEqual(14);
  });

  it("requires explicit .ts on every relative import in the graph", () => {
    const { violations } = collectGraph();
    expect(violations).toEqual([]);
  });
});
