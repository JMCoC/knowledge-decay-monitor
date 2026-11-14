import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_API_URL = "http://127.0.0.1:54321";
const DEFAULT_PROJECT_ID = "knowledge-decay-monitor-s1-02";

export interface LocalSupabaseTarget {
  apiUrl: string;
  projectId: string;
  workdir: string;
  disposableReview: boolean;
}

/** Resolve only the checkout's local stack or a runner-owned review stack under the OS temp root. */
export function localSupabaseTarget(): LocalSupabaseTarget {
  const apiUrl = process.env.KDM_LOCAL_SUPABASE_URL ?? DEFAULT_API_URL;
  const projectId = process.env.KDM_LOCAL_SUPABASE_PROJECT_ID ?? DEFAULT_PROJECT_ID;
  const workdir = resolve(process.env.KDM_LOCAL_SUPABASE_WORKDIR ?? process.cwd());
  const disposableReview = process.env.KDM_LOCAL_SUPABASE_DISPOSABLE === "review";

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    throw new Error("Local Supabase test environment has an invalid API URL.");
  }
  const loopback = parsedUrl.protocol === "http:"
    && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsedUrl.hostname)
    && /^[1-9][0-9]{3,4}$/.test(parsedUrl.port);
  if (!loopback) throw new Error("Local Supabase tests require an HTTP loopback API URL.");

  if (!disposableReview) {
    if (apiUrl !== DEFAULT_API_URL || projectId !== DEFAULT_PROJECT_ID || workdir !== resolve(process.cwd())) {
      throw new Error("Refusing to use a non-checkout Supabase project without the disposable review runner.");
    }
  } else {
    const tempRoot = resolve(tmpdir());
    const relativeRoot = relative(tempRoot, workdir);
    if (
      !/^kdm-review-[a-f0-9]{16}$/i.test(projectId)
      || !basename(workdir).startsWith("kdm-s3-02-review-")
      || !isAbsolute(workdir)
      || relativeRoot === ""
      || relativeRoot === ".."
      || relativeRoot.startsWith(`..${sep}`)
      || isAbsolute(relativeRoot)
    ) {
      throw new Error("The disposable review Supabase project is outside its generated temp workspace.");
    }
  }

  const configPath = resolve(workdir, "supabase", "config.toml");
  let config: string;
  try {
    config = readFileSync(configPath, "utf8");
  } catch {
    throw new Error("The configured local Supabase project is unavailable.");
  }
  if (!config.split(/\r?\n/).some((line) => line.trim() === `project_id = "${projectId}"`)) {
    throw new Error("The local Supabase project ID does not match its configuration.");
  }
  return { apiUrl, projectId, workdir, disposableReview };
}
