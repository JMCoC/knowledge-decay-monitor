/*
 * The Next.js TypeScript program does not read Deno import maps. The Deno test
 * command resolves this specifier from deno.json and checks against the pinned
 * SDK's actual declarations.
 */
declare module "@sentry/deno" {
  export type Event = Record<string, unknown> & {
    tags?: Record<string, unknown>;
    contexts?: Record<string, unknown>;
  };

  export interface DenoTransport {
    send(envelope: unknown): PromiseLike<{ statusCode?: number }>;
    flush(timeout?: number): PromiseLike<boolean>;
  }

  export interface DenoOptions {
    dsn?: string;
    environment?: string;
    release?: string;
    defaultIntegrations?: false;
    integrations?: unknown[];
    sendDefaultPii?: boolean;
    enableLogs?: boolean;
    maxBreadcrumbs?: number;
    tracesSampleRate?: number;
    skipOpenTelemetrySetup?: boolean;
    transport?: (options: unknown) => DenoTransport;
  }

  export interface DenoClient {
    getTransport(): DenoTransport | undefined;
  }

  export function init(options?: DenoOptions): DenoClient;
  export function getClient(): DenoClient | undefined;
  export function captureEvent(event: Event): string;
  export function flush(timeout?: number): Promise<boolean>;
  export function close(timeout?: number): Promise<boolean>;
  export function addEventProcessor(processor: (event: Event) => Event | null): void;
}
