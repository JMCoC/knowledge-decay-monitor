import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
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

function withinAllowedDirs(absolutePath: string, allowedDirs: string[]): boolean {
  return allowedDirs.some((dir) => {
    const fromAllowedDir = relative(dir, absolutePath);
    return fromAllowedDir === "" || (
      fromAllowedDir !== ".." &&
      !fromAllowedDir.startsWith(`..${sep}`) &&
      !isAbsolute(fromAllowedDir)
    );
  });
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

function collectGraph(
  entry: string = ENTRY,
  allowedDirs: string[] = ALLOWED_DIRS,
): { files: string[]; violations: string[] } {
  const files: string[] = [];
  const violations: string[] = [];
  const visited = new Set<string>();
  const queue = [entry];
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
        withinAllowedDirs(absolute, allowedDirs) &&
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

  it("finds extensionless imports inside child modules", () => {
    const root = mkdtempSync(join(tmpdir(), "kdm-deno-graph-"));
    const allowedDir = join(root, "analyze");
    const entry = join(allowedDir, "index.ts");
    const child = join(allowedDir, "child.ts");

    try {
      mkdirSync(allowedDir, { recursive: true });
      writeFileSync(entry, 'import { child } from "./child.ts";\n');
      writeFileSync(child, 'import { leaf } from "./leaf";\n');

      const collectFixtureGraph = collectGraph as unknown as (
        entry: string,
        allowedDirs: string[],
      ) => ReturnType<typeof collectGraph>;
      const graph = collectFixtureGraph(entry, [allowedDir]);

      expect(graph.files).toHaveLength(2);
      expect(graph.violations).toHaveLength(1);
      expect(graph.violations[0]).toContain(`${child}:1 -> ./leaf`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
