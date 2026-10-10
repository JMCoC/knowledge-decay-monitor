import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const LOCAL_PROJECT_ID = "knowledge-decay-monitor-s1-02";
const QUERY_TIMEOUT_MS = 5000;

export class LocalSqlError extends Error {
  constructor(readonly sqlState: string | null, reason: "query" | "timeout" | "session") {
    super(reason === "query"
      ? `Local SQL operation failed${sqlState ? ` (SQLSTATE ${sqlState})` : ""}.`
      : reason === "timeout"
        ? "Local SQL operation exceeded its test timeout."
        : "The local SQL session is unavailable.");
    this.name = "LocalSqlError";
  }
}

export interface LocalSqlSession {
  readonly pid: number;
  query(sql: string): Promise<string>;
  close(): Promise<void>;
}

function localDatabaseContainer() {
  if (process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Refusing to open SQL outside the expected local Supabase API.");
  }
  let config: string;
  let names: string;
  try {
    config = readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf8");
    names = execFileSync(
      "docker",
      ["ps", "--filter", `name=supabase_db_${LOCAL_PROJECT_ID}`, "--format", "{{.Names}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    ).trim();
  } catch {
    throw new Error("The expected local Supabase project is unavailable.");
  }
  if (!new RegExp(`^\\s*project_id\\s*=\\s*"${LOCAL_PROJECT_ID}"\\s*$`, "m").test(config)) {
    throw new Error("The local Supabase project ID does not match the integration fixture.");
  }
  const matches = names.split(/\r?\n/).filter((name) => name === `supabase_db_${LOCAL_PROJECT_ID}`);
  if (matches.length !== 1) throw new Error("Expected exactly one local project database container.");
  return matches[0];
}

export async function openLocalSqlSession(applicationName: string): Promise<LocalSqlSession> {
  if (!/^kdm_[a-z0-9_]{1,48}$/.test(applicationName)) {
    throw new Error("The local SQL application name is not a test marker.");
  }
  const container = localDatabaseContainer();
  const child = spawn(
    "docker",
    ["exec", "-i", container, "psql", "-XAt", "-U", "postgres", "-d", "postgres"],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  let stdoutBuffer = "";
  let closed = false;
  let active: {
    marker: string;
    output: string[];
    errors: string;
    resolve(value: string): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  } | null = null;
  let queue = Promise.resolve();

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!active) continue;
      if (line === active.marker) {
        const sqlState = [...active.errors.matchAll(/(?:ERROR|FATAL):\s*(\d{5}):/g)].at(-1)?.[1] ?? null;
        const request = active;
        active = null;
        clearTimeout(request.timer);
        if (sqlState) request.reject(new LocalSqlError(sqlState, "query"));
        else request.resolve(request.output.join("\n").trim());
      } else {
        active.output.push(line);
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    if (active) active.errors += chunk;
  });
  child.on("error", () => {
    closed = true;
    if (active) {
      clearTimeout(active.timer);
      active.reject(new LocalSqlError(null, "session"));
      active = null;
    }
  });
  child.on("exit", () => {
    closed = true;
    if (active) {
      clearTimeout(active.timer);
      active.reject(new LocalSqlError(null, "session"));
      active = null;
    }
  });

  const query = (sql: string) => {
    const operation = queue.then(() => new Promise<string>((resolveQuery, rejectQuery) => {
      if (closed || child.stdin.destroyed) {
        rejectQuery(new LocalSqlError(null, "session"));
        return;
      }
      const marker = `__KDM_SQL_${randomUUID().replaceAll("-", "")}__`;
      const request = {
        marker,
        output: [] as string[],
        errors: "",
        resolve: resolveQuery,
        reject: rejectQuery,
        timer: setTimeout(() => {
          if (active?.marker !== marker) return;
          active = null;
          closed = true;
          child.kill();
          rejectQuery(new LocalSqlError(null, "timeout"));
        }, QUERY_TIMEOUT_MS),
      };
      active = request;
      child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    }));
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  try {
    const identity = await query(`\\set VERBOSITY verbose\n\\set SHOW_CONTEXT never\nSET application_name = '${applicationName}';\nSELECT pg_backend_pid();`);
    const pid = Number(identity.split(/\r?\n/).at(-1));
    if (!Number.isInteger(pid) || pid < 1) throw new LocalSqlError(null, "session");
    return {
      pid,
      query,
      async close() {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolveClose) => {
          const timer = setTimeout(() => {
            child.kill();
            resolveClose();
          }, 1000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolveClose();
          });
          child.stdin.end("\\q\n");
        });
      },
    };
  } catch (error) {
    closed = true;
    child.kill();
    throw error;
  }
}

export async function waitForSqlLock(observer: LocalSqlSession, pid: number, blockerPid: number, timeoutMs = 2000) {
  if (!Number.isInteger(pid) || pid < 1 || !Number.isInteger(blockerPid) || blockerPid < 1) {
    throw new Error("Valid local PostgreSQL session PIDs are required.");
  }
  const boundedMs = Math.max(1, Math.min(timeoutMs, 800));
  const observed = await observer.query(`
    do $wait_for_lock$
    declare
      lock_seen boolean := false;
      deadline timestamptz := clock_timestamp() + (${boundedMs} * interval '1 millisecond');
    begin
      loop
        select exists (
          select 1 from pg_stat_activity
          where pid = ${pid} and ${blockerPid} = any(pg_catalog.pg_blocking_pids(pid))
        ) into lock_seen;
        exit when lock_seen or clock_timestamp() >= deadline;
        perform pg_sleep(0.005);
      end loop;
      perform set_config('kdm_test.lock_observed', lock_seen::text, false);
    end
    $wait_for_lock$;
    select current_setting('kdm_test.lock_observed', true);
  `);
  if (observed.split(/\r?\n/).at(-1)?.trim() !== "true") {
    throw new Error("The expected local SQL session did not block the processing call.");
  }
}
