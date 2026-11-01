# S2-11 notification dispatch contract

## Edge request

`dispatch-notifications` is a private scheduler endpoint. Supabase JWT verification is disabled for this function because the caller is `pg_cron`; every request must instead pass the independent `NOTIFICATIONS_INTERNAL_TOKEN` in an `Authorization: Bearer ...` header. Do not use or derive this token from a Supabase key.

The only accepted request is:

```http
POST /functions/v1/dispatch-notifications
Authorization: Bearer <NOTIFICATIONS_INTERNAL_TOKEN>
Content-Type: application/json

{}
```

The body is limited to 1024 bytes and must be exactly an empty JSON object. The endpoint accepts no tenant, recipient, event, or analysis parameters. It authenticates before reading the body or creating a database client.

| Status | Meaning |
| --- | --- |
| `202 {"accepted":true}` | The authenticated trigger passed readiness and its bounded background task was registered. This does not mean an email was sent. |
| `400 {"error":"invalid_request"}` | The content type, JSON, object shape, encoding, or body size is invalid. |
| `401 {"error":"unauthorized"}` | With runtime configuration enabled, the Bearer token is missing or incorrect. |
| `405 {"error":"method_not_allowed"}` | The method is not `POST`; the response includes `Allow: POST`. |
| `503 {"error":"not_ready"}` | Runtime configuration, reporting, database readiness, the shared database gate, or background-task registration is unavailable. No event is claimed. |

The response never includes queue counts, recipient data, provider responses, or dispatch errors. Email and alert delivery happen in the registered task; the durable notification rows remain the source of truth.

## Runtime configuration

The Edge Function reads these values from its runtime environment:

| Name | Requirement |
| --- | --- |
| `NOTIFICATIONS_ENABLED` | `1` or `true` to serve; absent, `0`, or `false` fails closed with `503`. Other values fail readiness. |
| `NOTIFICATIONS_INTERNAL_TOKEN` | At least 32 characters and no whitespace. It is independent from Supabase keys. |
| `RESEND_API_KEY` | Private Resend credential. |
| `NOTIFICATIONS_FROM` | Exactly `Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>`. |
| `APP_ORIGIN` | A valid HTTPS origin or an explicit loopback HTTP origin. |
| `SUPABASE_URL` | Supabase service origin. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key used by the store and readiness RPC. |
| `SENTRY_DSN` | Valid Sentry DSN; reporting must initialize before the database readiness check. |
| `NOTIFICATIONS_ENVIRONMENT` | `development`, `vercel-preview`, or `vercel-production`. |
| `NOTIFICATIONS_RELEASE_SHA` | Forty hexadecimal characters; `-dirty` is allowed only for `development`. |

Do not log these values or include them in a response. The environment switch and the database switch are independent; both must be enabled before the Edge task can claim work.

## Database scheduler

The migration creates the shared `private.notification_dispatch_settings` gate with `enabled = false`; it does not create a cron job. `public.notifications_dispatch_enabled()` exposes only the gate state to `service_role`. Both event claims and alert claims take a shared lock on the enabled row. A successful disable therefore waits for current claim transactions, prevents subsequent claims, and removes the named job. It cannot cancel an HTTP request or provider request already in flight.

Store these two values in Supabase Vault before enabling the schedule:

| Vault name | Value |
| --- | --- |
| `notifications_function_url` | Exact `/functions/v1/dispatch-notifications` endpoint on the Supabase project host, or one of the local Docker aliases below. |
| `notifications_internal_token` | Same independent secret configured as `NOTIFICATIONS_INTERNAL_TOKEN`; at least 32 characters, no whitespace. |

Allowed local URLs:

```text
http://api.supabase.internal:8000/functions/v1/dispatch-notifications
http://kong:8000/functions/v1/dispatch-notifications
```

Hosted URLs must match `https://<20-character-project-ref>.supabase.co/functions/v1/dispatch-notifications` or the equivalent `.supabase.in` host, with no query, fragment, port, or extra path. The function rejects every other host or path before invoking `pg_net`.

Only `service_role` can invoke `public.configure_notifications_dispatch(boolean)`. Enabling validates Vault, opens the shared gate, removes duplicate jobs with the same name, and schedules exactly one `kdm-notifications-dispatch` job for `* * * * *`. Disabling closes the gate and unschedules all jobs with that name in the same transaction:

```sql
select public.configure_notifications_dispatch(true);
select public.configure_notifications_dispatch(false);
```

The private `private.invoke_notifications_dispatch()` caller is executable only by `postgres`. It sends a two-second `pg_net` POST containing `{}` and the Bearer token, and returns only the `pg_net` request ID. A scheduled HTTP enqueue is not proof of Edge acceptance or email delivery.

## Local checks and rollout boundary

Local integration checks use `NOTIFICATIONS_ENABLED=0` unless a test explicitly injects dependencies. The SQL scheduler test runs inside a transaction and rolls back its temporary Vault secrets and cron changes. Local validation must not enable the schedule against real credentials or send real email. Hosted activation and real delivery require a separate operational rollout decision.
