# Runbook — S2-11 analysis notifications

**Default state:** disabled. Installing the migrations does not create an active
job, store credentials, or send email. Keep the flag and database scheduler
disabled until the operator has approved the concrete test recipients and the
local backlog has been reviewed.

This runbook covers the notification dispatcher only. It does not change Auth
recovery SMTP, analysis providers, findings, credits, or S2-12 AI/corpus
acceptance. `sent` means Resend accepted the request; only an operator's check
of the controlled inbox proves receipt.

## 1. Readiness and secret locations

The sender is fixed to
`Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>`.
Before a real delivery, confirm that the domain is still verified in Resend,
the key is sending-only and restricted to that domain, and domain-level open
and click tracking are disabled. The previously observed verified domain and
working password-recovery flow do not prove that S2-11 has a usable sending
key or has delivered a notification.

| Name | Location | Rule |
|---|---|---|
| `NOTIFICATIONS_ENABLED` | Edge runtime | Missing defaults to `0`. Keep at `0` until explicit activation approval. |
| `NOTIFICATIONS_INTERNAL_TOKEN` | Edge runtime and DB Vault | Random, at least 32 characters, no whitespace; both copies must match. |
| `RESEND_API_KEY` | Edge runtime only | Sending-only key, limited to the verified sender domain. Never expose to the browser or CI. |
| `NOTIFICATIONS_FROM` | Edge runtime | Exact fixed sender above. |
| `APP_ORIGIN` | Edge runtime | Canonical app origin, HTTPS, no path/query/fragment. |
| `SUPABASE_URL` | Edge runtime | The same project that owns the event outbox. |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge runtime only | Privileged key; never in `NEXT_PUBLIC_*`, test output, or browser configuration. |
| `SENTRY_DSN` | Edge runtime | Sentry Deno project DSN; keep in private runtime configuration. |
| `NOTIFICATIONS_ENVIRONMENT` | Edge runtime | `development`, `vercel-preview`, or `vercel-production`. |
| `NOTIFICATIONS_RELEASE_SHA` | Edge runtime | 40 hexadecimal characters; `-dirty` is accepted only in development. |
| `notifications_function_url` | Database Vault | Exact dispatcher URL. Locally use `http://api.supabase.internal:8000/functions/v1/dispatch-notifications`; hosted use that project's `/functions/v1/dispatch-notifications` URL. |
| `notifications_internal_token` | Database Vault | Same private token as `NOTIFICATIONS_INTERNAL_TOKEN`. |

Keep local Edge values in a private environment file outside the repository,
or in a repository-local ignored `.env*` file. Start the local function with the
project's pinned Supabase CLI:

```powershell
$env:KDM_NOTIFICATIONS_ENV = Join-Path $env:LOCALAPPDATA 'KDM\dispatch-notifications.env'
pnpm exec supabase functions serve dispatch-notifications --no-verify-jwt --env-file $env:KDM_NOTIFICATIONS_ENV
```

The function still checks the internal Bearer token in its handler; disabling
Supabase JWT verification does not make the endpoint unauthenticated. The local
CLI command is provided for the current pinned CLI 2.117.0. Do not print the
environment file or copy it into tickets, logs, screenshots, or commits.

For a hosted project, store the Edge values in that project's private function
secrets. With the repository's Supabase CLI 2.117.0, the supported command is
`pnpm exec supabase secrets set --env-file <private-env-file> --project-ref
<project-ref>`. Use an env file containing only the intended S2-11 keys and
leave `NOTIFICATIONS_ENABLED=0` while provisioning. This command changes hosted
configuration; it is not part of local verification and requires its own
authorization. Set `APP_ORIGIN` in the application environment as well if the
app uses that value for its login links.

The two `notifications_*` entries belong in that database's Vault, separately
from Edge secrets. Use the Dashboard's Vault controls or a private database
session to create/update them; do not select `vault.decrypted_secrets`, put
values in a migration, or save a query containing values in the repository.
The Resend API key never belongs in Vault because only the Edge sender needs
it.

## 2. Preflight before enabling anything

First confirm the migrations are applied and inspect only scheduler state,
notification IDs, types, timestamps, and controlled authorization booleans.
These queries do not return email addresses or message bodies:

```sql
select enabled
from private.notification_dispatch_settings
where id;

select jobid, jobname, schedule, active
from cron.job
where jobname = 'kdm-notifications-dispatch';

select e.id, e.type, e.status, e.created_at,
       (e.recipient_id = a.initiator_id
        and p.workspace_id = e.workspace_id
        and p.role::text in ('Admin', 'QA Lead')
        and lower(btrim(p.email)) = lower(btrim(u.email))
        and ((e.type = 'analysis_completed' and a.status = 'completed')
          or (e.type = 'analysis_failed' and a.status = 'failed'))
        and (u.banned_until is null or u.banned_until <= clock_timestamp())
        and u.deleted_at is null) as recipient_authorized
from public.notification_events e
join public.analyses a on a.id = e.analysis_id and a.workspace_id = e.workspace_id
left join public.profiles p on p.id = e.recipient_id and p.workspace_id = e.workspace_id
left join auth.users u on u.id = e.recipient_id
where e.status = 'pending'
order by e.created_at, e.id;

select count(*) as active_email_leases
from public.notification_events
where status = 'pending' and operation_id is not null
  and lease_expires_at > clock_timestamp();

select count(*) as active_alert_leases
from private.notification_deliveries
where alert_operation_id is not null
  and alert_lease_expires_at > clock_timestamp();
```

`recipient_authorized=true` confirms the persisted role, tenant, analysis
status, and Auth/Profile identity checks; it does **not** prove that the inbox
is controlled by the operator. Confirm control out of band without recording
the address in test artifacts. The scheduler has no per-event allowlist: when
enabled it consumes the global due backlog (up to five email candidates per
dispatch). Do not enable it if any pending event is not approved for delivery.
Use an isolated local Supabase project for a two-message test when the personal
backlog cannot be safely included.

Before approval, the expected local baseline is `enabled=false`, no
`kdm-notifications-dispatch` cron row, and zero active email/alert leases. Do
not disable a job or gate that you did not create for this test.

## 3. Real Resend delivery (operator-controlled test only)

Use a local Admin/QA Lead account whose Auth email matches its Profile email
and whose mailbox the operator controls. Produce one completed and one terminal
failed result through real S2-08 finalization with synthetic analysis data. A
fake local analysis provider may create the failed result without changing real
Cerebras/Groq credentials; do not fake the notification RPCs or override the
persisted recipient. Review every pending backlog row first because activation
processes all authorized due events, not only the two test events.

After the operator has explicitly approved the recipients and sends:

1. Start the local dispatcher with a private env file containing all required
   runtime names and `NOTIFICATIONS_ENABLED=1`.
2. Store the matching function URL and token in the local database Vault.
3. Confirm the pending backlog and leases again, then call
   `select public.configure_notifications_dispatch(true);` from the local
   database. This creates the one-minute `kdm-notifications-dispatch` job.
4. Wait for the cron invocation. A dispatcher HTTP `202` means the bounded
   Edge run was accepted; it does not prove Resend acceptance or inbox receipt.
5. Inspect event IDs, type, status, `sent_at`, and controlled error code only.
   Check the controlled inbox for each message's subject, original terminal
   date, minimal body, and login link. Complete login and confirm the link
   resolves only to the persisted analysis UUID.
6. Disable with `select public.configure_notifications_dispatch(false);` and
   set the Edge flag back to `0`. Confirm the cron row is gone and all active
   email/alert leases have settled before stopping the local Edge runtime.

Do not use direct SQL updates to mark events sent, alter attempt counts, change
recipients, or bypass leases. A lost final acknowledgement can leave an
uncertain result; do not promise exactly-once delivery. `sent` is API
acceptance, not inbox delivery. Keep only redacted metadata (date, tested SHA,
event correlation, status and command result); do not save message bodies,
addresses, URLs, keys, or screenshots with private content.

## 4. Sentry smoke, separate from email

The Deno unit test uses an in-memory transport and proves filtering and status
handling only. It does not prove Sentry ingestion. A real Sentry check sends
one synthetic `DELIVERY_FAILED` event and no email. Use a separate local
environment and a private env file; do not run through
`scripts/with-local-supabase.mjs`, which removes the Sentry configuration.

After separate authorization and when a test DSN is available, run the official
Deno SDK directly. Restrict `--allow-net` to the DSN's ingest hostname, never
put the DSN itself on the command line, and expose only the three listed env
names to the code:

```powershell
pnpm dlx deno@2.9.6 eval --config supabase/functions/dispatch-notifications/deno.json --node-modules-dir=none --env-file $env:KDM_NOTIFICATIONS_ENV --allow-env=SENTRY_DSN,NOTIFICATIONS_ENVIRONMENT,NOTIFICATIONS_RELEASE_SHA --allow-net=<sentry-ingest-host>:443 'import * as Sentry from "@sentry/deno"; import { initNotificationsSentry } from "./supabase/functions/dispatch-notifications/sentry.ts"; const read=(name) => { const value=Deno.env.get(name); if (!value) throw new Error(`Missing ${name}`); return value; }; const eventId="f9d4f7be-49f2-4a63-a197-24cb7c1c0701"; const report=initNotificationsSentry({sentryDsn:read("SENTRY_DSN"),environment:read("NOTIFICATIONS_ENVIRONMENT"),release:read("NOTIFICATIONS_RELEASE_SHA")}); const accepted=await report({eventId,operationId:"92de6647-ef6e-4cab-8a5c-2b5f6c3a1f2d",code:"DELIVERY_FAILED"}); console.log(JSON.stringify({accepted,correlationId:eventId})); await Sentry.close(2000); if (!accepted) Deno.exit(1);'
```

The command's `accepted=true` proves a 2xx transport response after flush, not
that the event is visible in Sentry. Confirm the correlation ID, environment,
release and controlled failure code in the project UI; verify no request,
exception, email, token or sentinel fields appear. Do not send a Resend request
for this smoke.

## 5. Safe diagnostics

| Observation | Next check |
|---|---|
| `503 not_ready` | Confirm the feature flag and required Edge config names. Keep the gate closed while fixing configuration; do not print values. |
| `401` from cron | Compare the Edge and Vault internal tokens in private consoles without copying either value into output. |
| Pending event stays due | Inspect `next_attempt_at`, `attempt_count`, `operation_id`, and lease expiry; do not rewrite them manually. |
| Event becomes `failed` | Use only the controlled error code and attempt count. A final lost acknowledgement may be uncertain; do not resend manually. |
| Event is `sent`, inbox empty | Check the controlled inbox/spam and Resend's dashboard for the provider message ID. This is a receipt investigation, not a reason to reset the event. |
| Sentry alert remains pending | Inspect alert lease/backoff and Sentry's event lookup by correlation ID; do not retry the email to recover telemetry. |

Any hosted secret change, scheduler activation, real email, Sentry ingest, push,
or deployment remains a separate authorized operation.
