import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { localSupabaseTarget } from "./local-supabase-target";

const MAX_QUERY_MS = 10_000;
const SAFE_ROW = /^[a-z0-9_.:-]+(?:\|[a-z0-9_.:-]+)*$/i;

export interface ReviewSqlSession {
  readonly applicationName: string;
  execute(sql: string): Promise<string[]>;
  close(): Promise<void>;
}

export interface ReviewSqlSessions {
  readonly a: ReviewSqlSession;
  readonly b: ReviewSqlSession;
  readonly observer: ReviewSqlSession;
  waitForBlockedSession(applicationName: string, timeoutMs: number): Promise<void>;
}

interface ActiveRequest {
  marker: string;
  rows: string[];
  resolve(rows: string[]): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function databaseContainer() {
  const target = localSupabaseTarget();
  if (!target.disposableReview || process.env.KDM_LOCAL_SUPABASE_URL !== target.apiUrl) {
    throw new Error("Review SQL sessions require the runner-owned disposable project.");
  }
  const expectedRoot = resolve(target.workdir);
  const expectedName = `supabase_db_${target.projectId}`;
  try {
    const names = execFileSync("docker", ["ps", "--filter", `name=${expectedName}`, "--format", "{{.Names}}"], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }).trim().split(/\r?\n/).filter(Boolean);
    if (names.length !== 1 || names[0] !== expectedName) throw new Error("container mismatch");
    const labels = JSON.parse(execFileSync("docker", ["inspect", "--format", "{{json .Config.Labels}}", expectedName], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    })) as Record<string, unknown>;
    const running = execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", expectedName], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }).trim();
    if (running !== "true"
      || labels["com.supabase.cli.project"] !== target.projectId
      || typeof labels["com.supabase.cli.workdir"] !== "string"
      || resolve(labels["com.supabase.cli.workdir"]) !== expectedRoot) {
      throw new Error("container ownership mismatch");
    }
    return expectedName;
  } catch {
    throw new Error("Review SQL sessions could not verify the runner-owned database container.");
  }
}

function openSession(container: string, applicationName: string): Promise<ReviewSqlSession> {
  if (!/^kdm_review_[a-f0-9]{12}_[abo]$/i.test(applicationName)) {
    throw new Error("The review SQL application marker is invalid.");
  }
  return new Promise((resolveSession, rejectSession) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      "docker",
      ["exec", "-i", container, "psql", "-XAtq", "-F", "|", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let closed = false;
    let active: ActiveRequest | null = null;
    let queue = Promise.resolve();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).replace(/\r$/, "");
        stdout = stdout.slice(newline + 1);
        if (active) {
          if (line === active.marker) {
            const request = active;
            active = null;
            clearTimeout(request.timer);
            request.resolve(request.rows);
          } else if (line) {
            if (!SAFE_ROW.test(line) || line.length > 160) {
              const request = active;
              active = null;
              clearTimeout(request.timer);
              closed = true;
              child.kill();
              request.reject(new Error("Review SQL returned a non-synthetic row; output was suppressed."));
            } else {
              active.rows.push(line);
            }
          }
        }
        newline = stdout.indexOf("\n");
      }
    });
    child.stderr.on("data", () => {
      // Database diagnostics can contain SQL payloads. Never retain or surface them.
    });
    const failActive = () => {
      closed = true;
      if (!active) return;
      clearTimeout(active.timer);
      active.reject(new Error("Review SQL process ended before its synthetic result marker."));
      active = null;
    };
    child.on("error", failActive);
    child.on("exit", failActive);

    const execute = (sql: string) => {
      if (typeof sql !== "string" || sql.length === 0 || sql.length > 200_000) {
        return Promise.reject(new Error("Review SQL input is empty or exceeds its test limit."));
      }
      const operation = queue.then(() => new Promise<string[]>((resolveRows, rejectRows) => {
        if (closed || child.stdin.destroyed) {
          rejectRows(new Error("Review SQL process is unavailable."));
          return;
        }
        const marker = `KDM_END_${randomUUID().replaceAll("-", "")}`;
        const request: ActiveRequest = {
          marker,
          rows: [],
          resolve: resolveRows,
          reject: rejectRows,
          timer: setTimeout(() => {
            if (active?.marker !== marker) return;
            active = null;
            closed = true;
            child.kill();
            rejectRows(new Error("Review SQL operation exceeded its bounded timeout."));
          }, MAX_QUERY_MS),
        };
        active = request;
        child.stdin.write(`${sql}\n\\echo ${marker}\n`);
      }));
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    };

    void (async () => {
      try {
        const ready = await execute(`SET application_name = '${applicationName}'; SELECT 'READY';`);
        if (ready.length !== 1 || ready[0] !== "READY") throw new Error("Review SQL process was not ready.");
        resolveSession({
          applicationName,
          execute,
          async close() {
            if (closed) return;
            await queue;
            closed = true;
            await new Promise<void>((done) => {
              const timer = setTimeout(() => { child.kill(); done(); }, 1000);
              child.once("exit", () => { clearTimeout(timer); done(); });
              child.stdin.end("\\q\n");
            });
          },
        });
      } catch (error) {
        closed = true;
        child.kill();
        rejectSession(error instanceof Error ? error : new Error("Review SQL process could not start."));
      }
    })();
  });
}

/** Three persistent psql processes are available only while the disposable review runner owns the stack. */
export async function withReviewSqlSessions<T>(run: (sessions: ReviewSqlSessions) => Promise<T>): Promise<T> {
  const container = databaseContainer();
  const marker = randomUUID().replaceAll("-", "").slice(0, 12);
  const opened: ReviewSqlSession[] = [];
  try {
    const a = await openSession(container, `kdm_review_${marker}_a`);
    opened.push(a);
    const b = await openSession(container, `kdm_review_${marker}_b`);
    opened.push(b);
    const observer = await openSession(container, `kdm_review_${marker}_o`);
    opened.push(observer);
    const sessions: ReviewSqlSessions = {
      a,
      b,
      observer,
      async waitForBlockedSession(applicationName, timeoutMs) {
        if (![a.applicationName, b.applicationName].includes(applicationName)
          || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
          throw new Error("Review lock barrier requires a bounded worker session and timeout.");
        }
        const rows = await observer.execute(`
          create or replace function pg_temp.kdm_wait_review_lock(p_name text, p_timeout integer)
          returns text language plpgsql as $wait$
          declare v_deadline timestamptz := clock_timestamp() + p_timeout * interval '1 millisecond';
          begin
            loop
              if exists (
                select 1 from pg_stat_activity a
                where a.application_name = p_name and a.wait_event_type = 'Lock'
                  and cardinality(pg_catalog.pg_blocking_pids(a.pid)) > 0
              ) then return 'BLOCKED'; end if;
              if clock_timestamp() >= v_deadline then return 'TIMEOUT'; end if;
              perform pg_sleep(0.005);
            end loop;
          end;
          $wait$;
          select pg_temp.kdm_wait_review_lock('${applicationName}', ${timeoutMs});
        `);
        if (rows.length !== 1 || rows[0] !== "BLOCKED") {
          throw new Error("Review lock barrier was not reached within its database-side timeout.");
        }
      },
    };
    return await run(sessions);
  } finally {
    const closes = await Promise.allSettled(opened.map((session) => session.close()));
    if (closes.some((result) => result.status === "rejected")) {
      // The runner owns the whole stack and will stop it after this callback.
    }
  }
}
