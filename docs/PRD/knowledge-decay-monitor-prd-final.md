# Product Requirements Document (PRD)
# Knowledge Decay Monitor

**Version:** 1.0  
**Project type:** Academic B2B SaaS MVP  
**Team:** 3 Full-Stack Developers  
**Delivery window:** 12 weeks  
**Cadence:** 6 vertical-slice iterations of 2 weeks each  
**Primary market:** International software/technology startups  
**Primary UI language:** English  
**Status:** Discovery completed — Stages 1–4 approved

---

# 1. Executive Summary

Knowledge Decay Monitor is a B2B SaaS designed for software and technology startups that need to maintain trustworthy internal documentation.

The product focuses on a specific operational problem: documentation does not necessarily fail because organizations lack documents; it fails because different documents, procedures and versions gradually stop agreeing with one another. SOPs, policies, manuals, QA processes, security guidelines and engineering documentation can become contradictory, superseded or operationally unreliable without anyone noticing until an audit or internal review exposes the problem.

The MVP will allow an organization to manually upload private PDF, DOCX and Markdown files, preprocess and index them semantically, select which active document versions should be analyzed and compared, estimate the credit cost before execution, and run an asynchronous AI-assisted analysis that detects:

1. **Contradictions**, including both direct conflicts and softer inconsistencies.
2. **Obsolescence**, primarily when a newer document or version may replace an older one.

Every finding remains human-reviewed. The AI proposes findings, severity and explanations; the QA Lead or Admin confirms, rejects, reprioritizes, assigns and resolves them.

The defining product principle is:

> **AI proposes, evidence demonstrates, humans decide.**

The MVP intentionally avoids becoming a generic knowledge base, collaboration suite or document management platform. It does not include automatic third-party repository connectors, OCR, URLs, multi-workspace accounts, advanced analytics, comments/chat, SSO or automatic learning from false positives.

The system will be developed as six **vertical slices**, with each iteration producing a usable end-to-end version that crosses UI, backend, data, security and, when appropriate, AI capabilities.

---

# 2. Product Vision

## 2.1 Vision Statement

Help software teams maintain confidence in their internal operating knowledge by detecting documentation contradictions and potentially obsolete content before those problems become operational failures.

## 2.2 Core Value Proposition

Knowledge Decay Monitor transforms document maintenance from a reactive activity into a proactive quality workflow.

Instead of waiting until an audit, review or operational failure reveals that documentation is inconsistent, the product allows teams to:

- upload controlled internal documentation;
- detect contradictory information;
- detect possible document supersession;
- inspect exact evidence;
- prioritize findings by severity;
- assign remediation;
- submit corrected versions;
- approve or reject changes;
- manually reanalyze updated documents.

## 2.3 Product Positioning

Proposed positioning:

> **An AI-powered documentation quality monitor for software teams that detects contradictions and obsolete documentation before they become operational problems.**

The MVP does **not** position itself as:

- a replacement for Notion, Confluence or general-purpose wikis;
- an enterprise search platform;
- a compliance certification product;
- a fully autonomous knowledge maintenance system;
- a generic AI chatbot over company documents.

---

# 3. Business Context

## 3.1 Target Customer Segment

Initial target:

- Software / technology companies.
- Startup stage.
- Approximately **30–100 employees**.
- International market.
- Product UI in English.

## 3.2 Buyer Persona

### CTO

The CTO is the primary commercial buyer and the initial user who may discover and create the workspace.

Primary concerns:

- operational risk;
- software delivery errors caused by incorrect process documentation;
- confidence in internal procedures;
- protection of confidential information and intellectual property;
- predictable cost of AI usage;
- avoiding unnecessary manual review overhead.

Primary buying barrier:

> **Security and protection of intellectual property.**

## 3.3 Primary User Persona

### QA Lead / Reviewer

The QA Lead is the main operational user.

Responsibilities within the product:

- upload documents;
- organize documents;
- execute analyses;
- review findings;
- change severity;
- confirm or reject findings;
- assign remediation;
- approve or reject corrected versions;
- manage non-Admin users;
- review historical versions;
- monitor document quality.

## 3.4 Secondary User

### Member

A Member is a remediation participant rather than a product administrator.

A Member:

- sees only directly assigned findings and documents;
- reviews evidence;
- uploads corrected versions for assigned work;
- sees the history of their own approved assignments.

A Member does not:

- browse the global repository;
- execute analysis;
- change finding state or severity;
- approve versions;
- manage users;
- buy credits;
- access historical document versions globally.

---

# 4. Problem Definition

## 4.1 Root Problem

The central problem is:

> **Operational misalignment caused by untrustworthy internal documentation.**

Teams may rely on procedures, manuals or policies that are:

- outdated;
- superseded;
- inconsistent with another document;
- internally contradictory;
- no longer representative of actual operating practice.

## 4.2 Typical Current Behavior

The expected current behavior is mostly reactive:

- teams trust documentation until a problem appears;
- inconsistencies are discovered manually;
- maintenance often occurs during audits or internal reviews;
- ownership and version validity may be unclear;
- there is no continuous specialized quality check across documents.

## 4.3 Main Moment of Pain

The issue is expected to become most visible during:

> **Audits and internal reviews.**

## 4.4 Business Consequences

### CTO impact

- incorrect decisions;
- software delivery bugs;
- process execution errors;
- increased operational risk;
- reduced trust in internal documentation.

### QA impact

- audit surprises;
- repeated manual comparison;
- difficulty identifying valid/current procedures;
- weak document control.

### Operations impact

- manual inventory work;
- wasted review time;
- rework;
- reactive corrections.

---

# 5. Product Goals

The MVP must:

1. Provide secure, tenant-isolated document storage.
2. Support PDF, DOCX and Markdown manual upload.
3. Preprocess, chunk and embed uploaded documents automatically.
4. Allow users to control exactly which active documents are analyzed and compared.
5. Estimate a fixed credit cost before analysis.
6. Detect contradiction candidates.
7. Detect potential document supersession/obsolescence.
8. Show evidence for every finding.
9. Keep humans in control of confirmation and remediation.
10. Support assignment and corrected-version workflows.
11. Provide permanent document deletion including derived data.
12. Provide pay-as-you-go prepaid credits.
13. Deliver the project in six vertical slices in 12 weeks.
14. Remain deployable and demo-ready throughout development.

---

# 6. Non-Goals

The MVP will not attempt to:

- become a general-purpose knowledge management suite;
- automatically synchronize with external repositories;
- automatically resolve findings;
- automatically mark documents as obsolete without human confirmation;
- build advanced machine-learning feedback loops;
- provide legal/compliance certification;
- build mobile-native applications;
- support enterprise SSO;
- support multiple workspaces per user;
- support scanned PDF OCR;
- provide advanced product analytics.

---

# 7. Product Principles

1. **AI proposes; humans decide.**
2. **Evidence is mandatory for findings.**
3. **Tenant isolation is non-negotiable.**
4. **Users control when credits are consumed.**
5. **Uploading a document never automatically triggers paid analysis.**
6. **Approving a version never automatically triggers paid reanalysis.**
7. **Only the minimum necessary document context is sent to the LLM.**
8. **No raw prompts or raw LLM responses are persisted.**
9. **Permanent deletion must remove original and derived document data.**
10. **MoSCoW controls scope in practice, not only in documentation.**
11. **No Could Have is implemented while a Must Have remains unstable or untested.**
12. **Each development iteration must produce a usable vertical slice.**

---

# 8. User Roles and Permissions

## 8.1 Admin

Can:

- create workspace;
- rename workspace;
- invite Admins, QA Leads and Members;
- create additional Admins;
- modify roles;
- remove users;
- upload new documents;
- upload versions;
- approve/reject versions;
- execute analyses;
- buy credits;
- view credit balance and full ledger;
- review findings;
- change severity;
- change finding states;
- assign findings;
- access all workspace documents;
- access historical versions;
- permanently delete documents;
- access Analysis History;
- access Audit Log.

Restriction: the last Admin cannot be removed or downgraded.

## 8.2 QA Lead / Reviewer

Can:

- view all workspace documents;
- upload new documents;
- upload versions;
- execute analyses;
- view balance and ledger;
- review findings;
- override severity;
- change finding state;
- assign findings;
- approve/reject corrected versions;
- permanently delete documents;
- access historical versions;
- invite QA Leads and Members;
- modify/remove QA Leads and Members;
- access Analysis History;
- access Audit Log.

Cannot:

- create Admins;
- modify Admins;
- remove Admins;
- rename workspace;
- buy credits.

## 8.3 Member

Can:

- view assigned documents;
- view assigned findings;
- view finding evidence;
- upload a corrected version for an assigned document;
- view history of their own approved assignments;
- view current workspace credit balance.

Cannot:

- browse global repository;
- view unrelated findings;
- view historical document versions globally;
- upload new logical documents;
- execute analyses;
- purchase credits;
- view detailed ledger;
- change finding severity;
- change finding state;
- approve/reject versions;
- delete documents;
- manage users.

---

# 9. Authentication and Workspace Model

## 9.1 Authentication

MVP authentication:

- Supabase Auth.
- Email + password.
- Immediate access after registration.
- Forgot Password included.
- No Google login.
- No Microsoft login.
- No magic links.
- No SSO.

## 9.2 Workspace Model

Each user belongs to exactly **one workspace** in the MVP.

The first user who creates a workspace automatically becomes **Admin**.

## 9.3 Invitations

Flow:

1. Admin or QA Lead enters an email.
2. Role is assigned.
3. Pending invitation is created.
4. Email is sent through Resend.
5. User registers or signs in with the same email.
6. User becomes part of that workspace with the assigned role.

Rules:

- invitations do not expire in the MVP;
- Admin can invite any role;
- QA Lead can invite QA Lead or Member;
- Member cannot invite;
- invitations can be revoked manually.

---

# 10. Supported Document Types

MVP supports:

- PDF with extractable text.
- DOCX.
- Markdown.

Limits:

- maximum **10 MB per file**;
- maximum **10 files per upload batch**.

Not supported:

- URLs;
- scanned PDFs requiring OCR;
- images as document sources;
- external knowledge connectors.

---

# 11. Document Metadata

Required metadata:

- Document Name.
- Category.
- Owner.

Owner:

- must reference an existing workspace user at creation;
- may become temporarily `Unassigned` if the user is removed.

Initial fixed categories:

- SOP
- Policy
- Manual
- QA Process
- Security
- Engineering Guideline
- Other

Custom categories are Post-MVP / Could Have.

---

# 12. Document and Version Model

## 12.1 Logical Documents

`documents` represents the logical document identity.

Recommended fields include:

- `id`
- `workspace_id`
- `name`
- `category`
- `owner_id`
- `active_version_id`
- timestamps

## 12.2 Document Versions

`document_versions` represents each physical file/version.

Version numbers are assigned automatically: v1, v2, v3, ...

Rejected versions keep their assigned number.

## 12.3 Version State Dimensions

### Processing status

- `uploaded`
- `processing`
- `ready`
- `processing_failed`

### Functional version status

- `pending_approval`
- `active`
- `historical`
- `rejected`

### Analysis status

- `pending_reanalysis`
- `analyzed`

## 12.4 Historical Versions

If Admin/QA retains a replaced version:

- it becomes `historical`;
- it is read-only;
- only Admin and QA Lead can access it;
- it cannot be reactivated.

## 12.5 Version Workflow

For Member correction:

1. Member uploads corrected version.
2. Version becomes `pending_approval`.
3. It is processed automatically.
4. Admin/QA reviews.
5. Admin/QA approves or rejects.

If rejected:

- rejection reason is mandatory;
- version becomes `rejected`;
- Member may submit another corrected version.

If approved:

- new version becomes `active`;
- previous version is retained as `historical` or deleted;
- `documents.active_version_id` is updated;
- new version remains `pending_reanalysis`;
- no paid analysis is triggered automatically.

---

# 13. Document Ingestion Pipeline

Upload is free from the analysis-credit perspective.

Pipeline:

1. Upload to private Supabase Storage.
2. Create document/version record.
3. `processing_status=uploaded`.
4. Server-side processing starts.
5. Parse text.
6. `processing_status=processing`.
7. Deterministic chunking.
8. Generate embeddings.
9. Store chunks + embeddings.
10. `processing_status=ready`.

If parsing fails:

- `processing_status=processing_failed`;
- version cannot be analyzed;
- user may retry processing or replace the file;
- no analysis credits are consumed.

---

# 14. Chunking Strategy

Chunking is deterministic.

Rules:

- prioritize headings;
- prioritize paragraphs;
- split oversized blocks only when needed;
- include limited overlap.

Initial configuration:

- **Target size: 450 tokens**
- **Overlap: 50 tokens**

Each chunk stores:

- text;
- version reference;
- order;
- page/section location;
- section heading/title;
- embedding.

---

# 15. Embeddings and Semantic Retrieval

## 15.1 Embedding Provider

MVP decision:

> Supabase `gte-small`

Exact availability and free usage conditions must be verified again during implementation.

## 15.2 Retrieval

Semantic retrieval:

- uses pgvector;
- searches only inside the user-selected version scope;
- retrieves a maximum of **Top K = 5** candidate chunks per query chunk;
- applies initial similarity threshold **0.75**.

The threshold may be adjusted during academic corpus testing.

Candidate pairs are temporary and are not persisted.

---

# 16. AI Provider Architecture

## 16.1 Provider Abstraction

The AI layer must expose an internal abstraction so business logic is not tied to one provider.

## 16.2 MVP Providers

Primary:

> **Cerebras Free**

Fallback:

> **Groq Free**

Embeddings:

> **Supabase `gte-small`**

Fallback sequence:

1. Call Cerebras.
2. If provider failure or invalid structured response, use Groq.
3. If the attempt fails completely, job retry logic applies.
4. After two job retries, the analysis fails and reserved credits are released.

## 16.3 Azure Review

**\* Review during implementation:** evaluate whether the project has access to an Azure account with available credits and whether Azure OpenAI / Azure AI should be used as an alternative.

The MVP must not depend on Azure credits being available.

## 16.4 Free Tier Caveat

Free provider availability and limits can change. These conditions must be reverified during integration. The provider abstraction is therefore a Must Have.

---

# 17. AI Privacy and Security Rules

Only the minimum necessary context may be sent to an LLM.

Do not send:

- full documents when chunks are sufficient;
- unrelated workspace context;
- unnecessary user metadata.

Do not persist:

- complete prompts;
- raw model responses.

Persist only:

- structured finding type;
- severity;
- explanation;
- evidence references;
- provider;
- model;
- prompt version;
- schema version;
- embedding model;
- internal confidence;
- timestamps;
- basic latency/error metadata.

Document content is **untrusted data, never instructions**.

The LLM has no business-action tools.

Structured output is validated with Zod before persistence.

---

# 18. Contradiction Detection

The system detects direct contradictions, soft inconsistencies and contradictions inside the same document.

## 18.1 Direct contradictions

Examples:

- mutually exclusive rules;
- yes/no requirement conflicts;
- incompatible process instructions.

## 18.2 Soft inconsistencies

Examples:

- different owners;
- different values;
- different process steps;
- ambiguous rule variations.

## 18.3 Detection Pipeline

1. User selects source document(s).
2. User selects comparison scope.
3. Retrieve candidate chunks.
4. Apply similarity threshold.
5. Send candidate pair to LLM.
6. Validate structured output.
7. Deduplicate within current analysis.
8. Persist final finding.
9. Persist evidence.

Suggested structured output contains:

- `is_contradiction`
- `severity`
- `confidence`
- `explanation`
- evidence references

No `reasoning_category` is required.

---

# 19. Obsolescence Detection

Primary concept:

> A document may be obsolete when a newer version/document appears to replace it.

Pipeline:

1. Active document participates in analysis.
2. Retrieve semantically related versions.
3. LLM evaluates possible supersession.
4. LLM proposes possible replacement, severity, explanation, evidence and confidence.
5. Admin/QA confirms or rejects.

AI never definitively marks a document obsolete without human review.

---

# 20. Findings Model

A single `findings` table represents contradiction and obsolescence.

Recommended fields:

- `id`
- `workspace_id`
- `analysis_id`
- `type`
- `severity_original`
- `severity_current`
- `confidence`
- `status`
- `assignee_id`
- `explanation`
- timestamps

Confidence:

- normalized **0.0–1.0**;
- internal only;
- not shown to users;
- does not prevent persistence.

Severity:

- proposed directly by LLM;
- allowed values: High / Medium / Low;
- validated by backend;
- Admin/QA may override it.

---

# 21. Finding Workflow

Explicit state machine:

`pending_review → confirmed | false_positive`

`confirmed → update_planned | resolved`

`update_planned → resolved`

`false_positive → resolved`

No automatic state transitions based on AI.

`resolved` may be set manually even without a new version or successful reanalysis.

---

# 22. Evidence Model

Use a separate `finding_evidence` table.

A finding can have multiple evidence records.

Each record may contain:

- finding reference;
- document ID;
- document version ID;
- document chunk ID;
- page/section;
- section heading;
- exact evidence snapshot.

Evidence snapshot maximum:

> **2,000 characters**

If the source document is permanently deleted, its evidence snapshots are also deleted.

---

# 23. Finding Deduplication

Deduplication occurs **only within the same analysis run**.

Method:

- deterministic fingerprint using finding type + involved document version IDs + normalized evidence.

No historical suppression or semantic clustering is required.

---

# 24. Run Analysis User Flow

1. Documents have already been uploaded and preprocessed.
2. Admin/QA opens Run Analysis.
3. Selects `Documents to analyze`.
4. Selects `Compare against`.
5. Search/filter tools assist selection.
6. User may use `Select all filtered` or `Compare against entire repository` when within the limit.
7. System estimates credit cost.
8. User sees only `Estimated cost: X credits`.
9. User confirms.
10. Credits are reserved immediately.
11. Analysis job is created.
12. Worker is triggered.
13. UI shows `Queued`, `Processing`, `Completed` or `Failed`.
14. User may leave or log out.
15. User receives email on completion/failure.
16. Completed analysis opens the findings list.

---

# 25. Analysis Scope Rules

Only versions with:

- `version_status=active`
- `processing_status=ready`

may participate.

Excluded:

- historical;
- rejected;
- pending approval;
- processing failed.

An active version with `analysis_status=pending_reanalysis` may be analyzed.

Internal contradiction detection always runs on source documents.

External contradiction and obsolescence detection run against selected comparison documents.

---

# 26. Analysis Limits

MVP guardrail:

> **Maximum 20 active versions per analysis across source + comparison scope.**

`Compare against entire repository` can be used directly only when the eligible scope fits that limit.

**\* Review during testing.**

---

# 27. Analysis Job Model

One analysis entity is used for both user-visible history and technical execution.

Core properties include:

- workspace;
- initiator;
- status;
- selected configuration;
- estimated/fixed cost;
- reserved credits;
- provider/model metadata;
- retry count;
- idempotency key;
- lock/lease timestamps;
- started/completed timestamps;
- error metadata.

States:

- `queued`
- `processing`
- `completed`
- `failed`

---

# 28. Analysis Concurrency

Per workspace:

> **Only one active analysis at a time.**

Active means queued or processing.

This protects provider rate limits, credit consistency and implementation simplicity.

---

# 29. Analysis Idempotency

`Run Analysis` must be idempotent.

Double clicks or client retries cannot:

- create duplicate jobs;
- reserve credits twice.

Use an idempotency key and appropriate uniqueness/transactional controls.

---

# 30. Analysis Worker

Implementation:

> **Supabase Edge Function — Analysis Worker**

Flow:

1. Claim queued job atomically.
2. Move to processing.
3. Apply lease/lock.
4. Execute retrieval.
5. Evaluate candidates through AI provider abstraction.
6. Validate outputs with Zod.
7. Deduplicate.
8. Persist findings/evidence.
9. Mark completed.
10. Convert credit reservation to consumption.

Worker recovery:

- backend tries to invoke worker immediately;
- scheduled recovery checks stranded queued/processing jobs;
- stale lease can return job for retry.

Retries:

> **2 automatic retries**

After final failure:

- mark analysis failed;
- release all reserved credits;
- log to Sentry;
- allow Retry Analysis.

No partial successful result is accepted.

---

# 31. Credits and Monetization

## 31.1 Business Model

> Prepaid pay-as-you-go credits.

Credits never expire.

## 31.2 Credit Packages

Initial packages:

- **US$20 → 100 credits**
- **US$50 → 300 credits** — Recommended / Most Popular
- **US$100 → 700 credits** — best unit value

**\* Review after observing real resource consumption.**

## 31.3 Free Credits

Each new workspace receives:

> **50 promotional credits**

This is positioned approximately as enough to test up to around 10 documents, depending on configuration.

The promotional grant occurs exactly once per workspace, is idempotent and never expires.

## 31.4 Credit Cost Formula

Initial fixed formula:

`credits = ceil(1 + (chunks × 0.05) + (candidate_pairs × 0.20))`

Where:

- `1` = base cost;
- `0.05` = cost per chunk;
- `0.20` = cost per candidate pair;
- `ceil` = round upward to the next whole credit.

**\* Review after academic corpus testing and provider cost observation.**

The cost shown before execution is exactly the cost reserved and charged if successful.

---

# 32. Credit Reservation and Ledger

Credit operations use an append-only transactional ledger.

Suggested event types:

- `Purchased`
- `Promotional`
- `Reserved`
- `Consumed`
- `Released`

The system maintains transactionally consistent available/reserved balances.

Create analysis + reserve credits is one atomic database transaction.

If reservation fails, no analysis is created.

When analysis begins, the visible available balance decreases immediately.

If completed: Reserved → Consumed.

If failed: Reserved → Released.

---

# 33. Billing and Lemon Squeezy

Billing model:

- one-time prepaid packages;
- no recurring subscription.

Lemon Squeezy rules:

- checkout initiated from backend;
- successful browser redirect is not proof of payment;
- credits are issued only after validated webhook;
- webhook processing is idempotent.

`payment_transactions` is separate from `credit_ledger`.

It stores:

- workspace;
- external order/checkout reference;
- amount;
- currency;
- package;
- payment status;
- timestamps.

Refunds and chargebacks are Won’t Have in MVP.

---

# 34. Billing / Credits UI

Separate section:

> **Billing / Credits**

Admin:

- sees balance;
- sees full ledger;
- sees packages;
- can buy credits.

QA Lead:

- sees balance;
- sees full ledger;
- cannot buy.

Member:

- sees only balance;
- does not see detailed ledger;
- cannot buy.

---

# 35. Document Search and Filters

Repository supports:

- search by name;
- filter by category;
- filter by owner;
- filter by version state.

Only Admin/QA have global repository access.

---

# 36. Findings UI

After a completed analysis, the user goes directly to the findings list.

Default order:

1. High
2. Medium
3. Low

Filters:

- finding type;
- severity;
- status;
- assignee.

Finding detail includes:

- type;
- severity;
- explanation;
- evidence;
- source document/version;
- page/section;
- side-by-side evidence where relevant;
- workflow controls.

---

# 37. Dashboard

Admin/QA dashboard includes:

- Total Active Documents
- Total Pending Findings
- Pending High Findings
- Pending Contradictions
- Pending Obsolete Documents
- Credit Balance

New workspace empty state includes:

- Upload Documents
- Invite QA Lead
- View Free Credits

No guided onboarding wizard is required.

---

# 38. Member Experience

Member does not receive the global dashboard.

Primary view:

> **My Assignments**

It contains:

- assigned findings;
- related active documents;
- evidence;
- corrected-version upload;
- own approved assignment history.

---

# 39. Corrected-Version Workflow

1. Admin/QA assigns finding to Member.
2. Member reviews assigned evidence.
3. Member uploads corrected version.
4. Version is processed automatically.
5. Version stays `pending_approval`.
6. Admin/QA reviews.
7. If rejected, rejection comment is required and Member may resubmit.
8. If approved, version becomes active; previous active version becomes historical or is deleted; new version becomes `pending_reanalysis`.
9. Admin/QA manually runs analysis later.

---

# 40. Notifications

Central table:

> `notification_events`

Example types:

- high_finding
- assignment
- version_rejected
- version_approved
- analysis_completed
- analysis_failed

States:

- `pending`
- `sent`
- `failed`

Retries:

> 2 automatic retries

If final delivery fails, mark failed and send the error to Sentry.

## 40.1 Immediate Emails

Immediate:

- High finding;
- analysis completed;
- analysis failed.

## 40.2 Daily Digest

Other non-urgent events are grouped.

MVP schedule:

> **23:00 UTC daily**

Per-user timezone/preferences are Post-MVP.

---

# 41. Audit Log

Use append-only table:

> `audit_events`

Recommended fields:

- workspace_id
- user_id
- action
- entity_type
- entity_id
- created_at
- minimal metadata JSON

Log important mutations:

- upload;
- deletion;
- analysis;
- severity changes;
- state changes;
- assignments;
- approvals/rejections;
- user/role changes;
- credit operations.

Do not log every document read/open/navigation event.

---

# 42. Analysis History

Admin and QA Lead can access Analysis History.

Each analysis shows:

- date/time;
- initiator;
- documents;
- exact versions;
- credits;
- status;
- findings.

Use `analysis_documents` to associate:

- analysis;
- logical document;
- exact version;
- relation type: `source` or `comparison`.

If a document is permanently deleted, historical versions/evidence/findings associated with it are removed; only minimal deletion audit remains.

---

# 43. Permanent Deletion

Only Admin and QA Lead may permanently delete documents.

Confirmation requires typing:

> `DELETE`

From the user’s perspective:

- document disappears immediately;
- no trash;
- no recovery;
- no “deletion in progress” UI.

Backend:

1. immediately makes document inaccessible;
2. creates `purge_job`;
3. purge runs asynchronously.

Delete:

- Storage object;
- document versions;
- chunks;
- embeddings;
- findings;
- assignments;
- evidence snapshots;
- analysis-derived references;
- historical derived data.

Keep only a minimal deletion audit event with no reconstructable document content.

---

# 44. Purge Worker

Separate Edge Function:

> **Purge Worker**

Separate table:

> `purge_jobs`

States:

- queued
- processing
- completed
- failed

Rules:

- only one active purge per document;
- idempotent;
- 2 automatic retries;
- Sentry on final failure.

---

# 45. Delete During Active Analysis

If a document involved in an active analysis is permanently deleted:

1. deletion wins;
2. document becomes inaccessible;
3. active analysis fails internally with document-deleted reason;
4. all reserved credits are released;
5. purge begins.

---

# 46. Storage Security

Documents are stored in private Supabase Storage.

No permanent public URLs.

Access is validated server-side and uses a short-lived signed URL.

Recommended initial expiry:

> **5 minutes**

Member access additionally checks direct assignment.

---

# 47. RLS and Tenant Security

RLS is mandatory for all business tables.

Primary tenant boundary:

> `workspace_id`

Rules:

- Workspace A can never access Workspace B.
- Admin/QA can access workspace-level resources according to permissions.
- Member can access only directly assigned documents/findings.

RLS must protect data even when UI is bypassed.

---

# 48. RLS Test Requirements

Automated tests must verify at minimum:

1. user from Workspace A cannot read Workspace B;
2. user from Workspace A cannot mutate Workspace B;
3. Member cannot access unassigned documents;
4. Member cannot access unassigned findings;
5. QA cannot create/modify/delete Admin;
6. unauthorized roles cannot execute analysis;
7. unauthorized roles cannot approve versions;
8. unauthorized roles cannot permanently delete documents.

---

# 49. Server Actions

Server Actions are used for application commands such as:

- create workspace;
- upload metadata;
- invite users;
- execute analysis request;
- approve/reject versions;
- update finding workflow;
- initiate checkout;
- request deletion.

Heavy analysis never executes synchronously in Server Actions.

---

# 50. Zod Validation

Zod is the common contract for:

- forms;
- Server Action inputs;
- internal command payloads;
- sensitive operations;
- LLM structured outputs;
- webhook data after verification;
- worker payloads where applicable.

Unvalidated LLM data is never persisted.

---

# 51. Observability

MVP uses:

> **Sentry only**

Sentry captures:

- application exceptions;
- worker failures;
- purge failures;
- notification failures;
- integration errors.

Sentry must not receive:

- document text;
- chunks;
- raw prompts;
- raw model output;
- secrets/tokens.

Use IDs and non-sensitive technical metadata only.

---

# 52. Testing Strategy

Testing is deliberately pragmatic.

## 52.1 Vitest

Use for:

- credit calculations;
- credit reservation/release;
- state machines;
- role/permission logic;
- pricing formula;
- deduplication;
- utility/domain logic.

## 52.2 RLS Tests

Must Have.

Security isolation is more important than generic coverage percentage.

## 52.3 Playwright

Use only for critical E2E flows such as:

- auth/workspace;
- upload;
- Run Analysis;
- findings workflow;
- version approval;
- credit checkout/accreditation where testable.

Playwright may run less frequently than unit/security CI.

---

# 53. CI/CD

Use:

- GitHub
- GitHub Actions
- Vercel
- Supabase migrations

Minimum CI:

1. lint
2. TypeScript type-check
3. Vitest
4. critical RLS tests

Deployment is blocked if these fail.

Playwright runs before important merges, sprint version closure and final demo.

---

# 54. Database Migrations

Use Supabase CLI / versioned SQL migrations in the repository.

Avoid untracked manual schema changes.

Migration source of truth:

> Git repository.

---

# 55. Deployment Environment

MVP uses one shared environment.

One main Supabase project and deployment configuration serve development/testing/demo.

Implications:

- destructive changes require caution;
- test data discipline is important;
- migrations must be reproducible.

No separate staging environment is required.

---

# 56. Responsive Design

MVP is responsive, desktop-first.

Reason:

- QA comparison;
- side-by-side evidence;
- document analysis;
- remediation workflow

are primarily desktop workflows.

No mobile application is required.

---

# 57. Market and Validation Strategy

The project will **not** depend on:

- real startup pilots;
- CTO outreach;
- QA Lead interviews;
- cold email;
- Product Hunt;
- paid acquisition;
- real conversion metrics.

Market assumptions remain hypotheses supported by secondary research, not commercial validation.

This limitation must be stated explicitly in the academic presentation and interpretation of the PRD.

---

# 58. Competitive Framing

The project acknowledges that AI-assisted knowledge maintenance already exists in the market.

Knowledge Decay Monitor differentiates through:

- narrow focus on document-quality monitoring;
- contradiction + obsolescence detection;
- evidence-first human review;
- explicit remediation workflow;
- pay-as-you-go credits;
- user-controlled comparison scope;
- strong permanent deletion promise.

The project will not attempt feature parity with broad enterprise knowledge platforms.

---

# 59. Academic Validation

Validation will use a controlled corpus created by the development team.

Corpus should contain:

- newer/older versions;
- explicit supersession cases;
- direct contradictions;
- soft inconsistencies;
- internal contradictions;
- documents with no intentional issues.

Validation is:

- functional;
- qualitative;
- end-to-end.

No mandatory quantitative accuracy target is defined for the MVP.

---

# 60. Academic Demo Scenario

Recommended demo:

1. CTO/Admin signs in.
2. Workspace already exists or is created.
3. Free credits are visible.
4. Representative files are uploaded.
5. Processing completes.
6. QA selects analysis scope.
7. Credit cost appears.
8. Run Analysis.
9. Analysis runs asynchronously.
10. Findings appear.
11. QA opens a High contradiction.
12. Side-by-side evidence is reviewed.
13. QA confirms and assigns to Member.
14. Member opens My Assignments.
15. Member uploads corrected version.
16. QA may reject once with a reason to demonstrate the workflow.
17. Member resubmits.
18. QA approves.
19. Version becomes active + Pending Reanalysis.
20. QA manually runs a new analysis.
21. Audit / Analysis History / Billing may be shown as supporting SaaS capabilities.

---

# 61. MoSCoW Prioritization

## 61.1 Must Have

### SaaS foundation

- Next.js + TypeScript + Tailwind.
- Supabase Auth.
- Email/password.
- Forgot password.
- One workspace per user.
- Admin / QA Lead / Member.
- Workspace invitations.
- RLS tenant isolation.
- Member assignment isolation.
- Private Storage.
- Server Actions.
- Zod.

### Documents

- PDF textual.
- DOCX.
- Markdown.
- 10 MB/file.
- 10 files/batch.
- name/category/owner metadata.
- fixed categories.
- automatic versioning.
- version lifecycle.
- processing lifecycle.
- analysis lifecycle.
- historical read-only versions.

### AI / analysis

- deterministic chunking.
- 450-token target.
- 50-token overlap.
- gte-small embeddings.
- pgvector.
- top K = 5.
- similarity threshold 0.75.
- Cerebras primary.
- Groq fallback.
- provider abstraction.
- structured Zod output.
- internal confidence.
- contradiction detection.
- internal contradiction detection.
- obsolescence detection.
- evidence.
- dedup within run.
- asynchronous processing.
- one active analysis/workspace.
- 2 retries.
- worker leases.
- idempotency.

### Human review

- High/Medium/Low.
- severity override.
- finding state machine.
- Confirmed / False Positive / Update Planned / Resolved.
- assignment.
- Member correction.
- approval/rejection.
- mandatory rejection reason.
- Pending Reanalysis.
- manual reanalysis.

### Credits / billing

- credit ledger.
- reservation.
- atomic analysis + reservation.
- fixed estimate.
- fixed formula.
- free 50 credits.
- packages:
  - 100 / $20
  - 300 / $50
  - 700 / $100
- Lemon Squeezy.
- validated webhook.
- payment_transactions.
- Admin-only purchase.

### Security / privacy

- tenant isolation.
- minimum LLM context.
- no raw prompt storage.
- no raw response storage.
- signed URLs.
- permanent deletion.
- Purge Worker.
- deletion of derived data.
- Sentry scrubbing.
- RLS tests.

### UX

- Admin/QA dashboard.
- repository.
- filters.
- findings list.
- finding detail.
- Billing/Credits.
- Settings.
- My Assignments.
- analysis state UI.
- email completion/failure.

### Reliability

- Sentry.
- critical Vitest.
- RLS tests.
- key Playwright E2E.
- CI quality gates.

## 61.2 Should Have

These remain part of the intended MVP but may be simplified if Must Have delivery is threatened:

- complete Analysis History UI;
- daily digest;
- polished ledger presentation;
- polished Audit Log presentation;
- broader email templates;
- secondary edge-case UX.

## 61.3 Could Have / Post-MVP

- semantic recommended document selection;
- user notification preferences;
- custom categories;
- export PDF/CSV;
- guided onboarding;
- advanced dashboards;
- user-specific timezone;
- additional provider configuration UI;
- richer analytics.

## 61.4 Won’t Have in 6 Sprints

- Notion connector.
- Google Drive connector.
- SharePoint connector.
- Confluence connector.
- URLs.
- OCR.
- scanned PDFs.
- internal chat/comments.
- false-positive learning.
- automatic historical finding suppression.
- multi-workspace users.
- social login.
- SSO.
- scheduled automatic analyses.
- job cancellation/pause/resume.
- trash/recovery.
- refund/chargeback workflows.
- mobile app.
- workspace deletion.
- advanced analytics.
- antivirus scanning.
- real commercial GTM execution.

---

# 62. Conceptual Data Model

Recommended main entities:

1. `workspaces`
2. `profiles`
3. `workspace_invitations`
4. `documents`
5. `document_versions`
6. `document_chunks`
7. `analyses`
8. `analysis_documents`
9. `findings`
10. `finding_evidence`
11. `credit_ledger`
12. `payment_transactions`
13. `notification_events`
14. `audit_events`
15. `purge_jobs`

Potential supporting fields/tables may be added during implementation, but the MVP should avoid unnecessary domain fragmentation.

---

# 63. Conceptual Architecture

```text
User
 │
 ▼
Next.js / TypeScript / Tailwind
 │
 ├── Supabase Auth
 │
 ├── Server Actions
 │
 ▼
Supabase PostgreSQL
 │
 ├── RLS / tenant isolation
 ├── business data
 ├── credit ledger
 ├── jobs
 ├── audit
 └── pgvector
 │
 ├──────────────► Supabase Storage (private)
 │
 ├──────────────► Analysis Edge Function
 │                   │
 │                   ├── semantic retrieval
 │                   ├── Cerebras
 │                   └── Groq fallback
 │
 ├──────────────► Purge Edge Function
 │
 ├──────────────► Notification/Digest Edge Function
 │                   └── Resend
 │
 └──────────────► Lemon Squeezy Webhooks

Monitoring:
Sentry
```

---

# 64. Vertical-Slice Delivery Plan

The six iterations are **not horizontal component sprints**.

Every sprint must produce a usable product version that crosses UI, backend, data, security and tests.

Approximate feature-work capacity:

> **60–65 hours per developer per sprint**

Team:

> approximately **180–195 planned feature hours per sprint**

Remaining capacity is reserved for integration, meetings, bugs, code review, testing, demo preparation and unexpected complexity.

---

# 65. Sprint 1 — Secure Document Repository v0.1

## Goal

Deliver a real, private, multi-tenant document repository end-to-end.

## Vertical Slice

User can:

> register → create workspace → become Admin → upload private document → document is processed → document appears in repository.

## Scope

- Next.js foundation.
- Tailwind shell/navigation.
- Supabase Auth.
- email/password.
- forgot password.
- workspace creation.
- first-user Admin.
- profiles/roles foundation.
- RLS foundation.
- private Supabase Storage.
- upload PDF/DOCX/Markdown.
- max file/batch validation.
- metadata.
- fixed categories.
- server-side parsing.
- document/document_versions.
- processing statuses.
- deterministic chunking.
- gte-small embedding.
- pgvector.
- document_chunks.
- repository list.
- repository search/filter basics.
- Sentry base.
- initial migrations.
- CI basics.
- initial RLS tests.

## Sprint Exit

A user can securely upload and browse analyzable private documentation with tenant isolation.

---

# 66. Sprint 2 — AI Analysis v0.2

## Goal

Deliver the first core product value: AI-assisted detection.

## Vertical Slice

Admin/QA can:

> select ready documents → see credit estimate → run asynchronous analysis → receive contradiction/obsolescence findings with evidence.

## Scope

- promotional 50 credits.
- credit ledger foundation.
- pricing formula.
- source/comparison selection.
- max 20 versions.
- Select all filtered.
- Compare against repository within guardrail.
- cost estimation.
- atomic reservation.
- analysis entity.
- analysis_documents.
- idempotent Run Analysis.
- Analysis Worker.
- atomic job claim.
- lease.
- 2 retries.
- top K = 5.
- similarity threshold = 0.75.
- Cerebras provider.
- Groq fallback.
- AIProvider abstraction.
- Zod output validation.
- contradiction detection.
- internal contradiction detection.
- obsolescence candidates.
- deterministic finding deduplication.
- findings.
- finding_evidence.
- evidence snapshot limit.
- findings list.
- High/Medium/Low order.
- analysis completion/failure notification.
- full credit release on failure.
- Retry Analysis.

## Sprint Exit

The product can securely detect and display reviewable documentation-quality issues end-to-end.

---

# 67. Sprint 3 — Human Review & Correction v0.3

## Goal

Complete the human-in-the-loop remediation cycle.

## Vertical Slice

QA can:

> review finding → confirm → assign → Member corrects document → QA approves → new active version waits for reanalysis.

## Scope

- findings state machine.
- severity override.
- original vs final severity.
- assignment.
- Member RLS restrictions.
- My Assignments.
- corrected version upload.
- pending approval.
- auto preprocessing of pending versions.
- rejection.
- mandatory rejection reason.
- approval.
- active version switching.
- active_version_id.
- historical version.
- delete-or-retain previous version choice.
- rejected versions.
- pending_reanalysis.
- manual reanalysis.
- relevant emails.
- workflow audit events.
- Vitest state-machine tests.
- critical Member access tests.

## Sprint Exit

The system supports detection → human decision → remediation → approval → reanalysis readiness.

---

# 68. Sprint 4 — SaaS Collaboration & Monetization v0.4

## Goal

Convert the core engine into an operational B2B SaaS.

## Vertical Slice

An Admin can:

> invite team → manage roles → purchase credits → QA uses credits → activity is auditable and notifications are delivered.

## Scope

- workspace_invitations.
- Resend invitation flow.
- Admin/QA invitation permissions.
- Settings.
- user management.
- last-Admin protection.
- Billing/Credits UI.
- ledger visualization.
- packages.
- Lemon Squeezy checkout.
- payment_transactions.
- webhook validation.
- idempotent accreditation.
- Audit Log.
- Analysis History.
- notification_events.
- immediate High alerts.
- daily digest at 23:00 UTC.
- notification retries.
- audit/billing RLS.
- main SaaS navigation polish.

## Sprint Exit

The product behaves as a real multi-user, prepaid-credit SaaS.

---

# 69. Sprint 5 — Security & Reliability v0.5

## Goal

Protect and stabilize all previously delivered flows.

## Vertical Slice

The system can:

> survive job/provider failures, enforce isolation, permanently delete sensitive IP, recover safely and expose operational failures through Sentry.

## Scope

- permanent delete UX.
- DELETE confirmation.
- logical immediate deletion.
- purge_jobs.
- Purge Worker.
- purge idempotency.
- 2 purge retries.
- one purge/document.
- delete active-analysis handling.
- derived-data deletion.
- minimal delete audit.
- job recovery.
- stale lease handling.
- provider fallback hardening.
- invalid JSON handling.
- Sentry scrubbing.
- RLS hardening.
- comprehensive critical RLS tests.
- credit concurrency tests.
- domain idempotency tests.
- parsing-failure flows.
- critical Playwright flows.
- signed URL hardening.

## Sprint Exit

Core flows are secure, recoverable and sufficiently robust for the final MVP demonstration.

---

# 70. Sprint 6 — MVP 1.0 / Academic Demo

## Goal

Deliver a stable, coherent academic MVP with all Must Haves complete.

## Vertical Slice

Demonstrate:

> workspace → upload → processing → credit estimate → analysis → findings → human review → assignment → correction → approval → reanalysis.

## Scope

- controlled academic corpus.
- direct contradictions.
- soft inconsistencies.
- internal contradictions.
- obsolete/superseded cases.
- non-problem documents.
- bug fixing.
- UX consistency.
- loading/empty/error states.
- final responsive desktop-first polish.
- final migration verification.
- critical E2E run.
- deployment verification.
- README/setup documentation.
- demo script.
- architecture documentation.
- PRD traceability review.
- Must Have completion review.

Could Haves enter only if every Must Have is complete, stable and tested.

## Sprint Exit

Knowledge Decay Monitor MVP 1.0 is deployable, demoable and academically defensible.

---

# 71. Sprint Planning Rule

No sprint is dedicated exclusively to frontend, backend, database, AI or testing.

Each iteration must ship a complete vertical capability.

Sprint 2, for example, is not “the AI sprint”; it includes UI, selection, credits, persistence, worker execution, AI, findings, failure handling, notifications and tests.

---

# 72. Functional Requirements Summary

## FR-01 Authentication
Users can register and sign in using email/password.

## FR-02 Workspace
First user creates one workspace and becomes Admin.

## FR-03 Invitations
Authorized roles can invite users by email.

## FR-04 Repository
Admin/QA can upload supported documents.

## FR-05 Preprocessing
Documents automatically parse, chunk and embed.

## FR-06 Search
Repository supports name search and filters.

## FR-07 Analysis Scope
Admin/QA explicitly selects source/comparison versions.

## FR-08 Credit Estimate
Exact credit cost appears before confirmation.

## FR-09 Credit Reservation
Credits reserve atomically with job creation.

## FR-10 Asynchronous Analysis
Analysis continues independent of web session.

## FR-11 Contradictions
System detects direct/soft/internal contradiction candidates.

## FR-12 Obsolescence
System detects potential replacement/supersession.

## FR-13 Evidence
Every finding includes traceable evidence.

## FR-14 Severity
System proposes High/Medium/Low; Admin/QA can override.

## FR-15 Review
Admin/QA manages the human review lifecycle.

## FR-16 Assignment
Confirmed/update-planned findings can be assigned.

## FR-17 Correction
Member can submit corrected version.

## FR-18 Approval
Admin/QA approves or rejects corrected version.

## FR-19 Reanalysis
Approved version requires manual reanalysis.

## FR-20 Billing
Admin buys prepaid credit packages.

## FR-21 Notifications
High findings and analysis outcomes can trigger immediate email.

## FR-22 Digest
Non-urgent events are summarized daily.

## FR-23 Analysis History
Admin/QA can inspect past analyses.

## FR-24 Audit Log
Important mutations are append-only audited.

## FR-25 Permanent Delete
Admin/QA can permanently delete document and derived data.

## FR-26 Member Isolation
Member sees only direct assignments.

---

# 73. Non-Functional Requirements

## Security

- RLS on business tables.
- private Storage.
- minimum-privilege role access.
- signed URLs.
- tenant isolation.
- no raw prompt/response persistence.
- Sentry data scrubbing.

## Reliability

- 2 analysis retries.
- 2 purge retries.
- 2 email retries.
- job idempotency.
- worker lease.
- atomic credit transactions.
- full credit release on failed analysis.

## Privacy

- permanent deletion of document-derived data.
- minimal post-deletion audit only.
- minimum context sent to LLM.

## Maintainability

- TypeScript.
- Zod.
- domain state machines.
- provider abstraction.
- versioned SQL migrations.
- separate workers.
- shared worker utilities.

## Performance

No formal numeric performance SLA is established for the academic MVP. Performance will be observed and adjusted during testing.

## Usability

- desktop-first;
- clear severity;
- direct evidence;
- no unnecessary onboarding wizard;
- simple analysis statuses;
- predictable credit cost.

---

# 74. Risks and Mitigations

## Risk 1 — False positives

**Risk:** contextual differences may be interpreted as contradictions.

**Mitigation:** human review, side-by-side evidence, severity override, False Positive state, controlled test corpus and no automatic operational decisions.

## Risk 2 — Free-tier provider limits

**Risk:** Cerebras/Groq limits may change or be exceeded.

**Mitigation:** provider abstraction, one analysis/workspace, top-K restriction, similarity threshold, primary/fallback provider and Azure-credit review.

## Risk 3 — Security/IP concerns

**Risk:** customers may not trust a documentation AI product.

**Mitigation:** RLS, private Storage, minimum-context LLM calls, no raw prompt persistence, permanent purge and tenant-isolation tests.

## Risk 4 — Over-scoping

**Risk:** three developers cannot build an enterprise knowledge platform in 12 weeks.

**Mitigation:** strict MoSCoW, manual uploads only, no connectors, no OCR, no comments, no advanced analytics and vertical slices.

## Risk 5 — AI output instability

**Risk:** malformed or inconsistent output.

**Mitigation:** structured output, Zod validation, fallback provider, retries and human review.

## Risk 6 — Credit inconsistency

**Risk:** duplicate reservation or concurrent overspend.

**Mitigation:** transactional ledger, atomic reserve/create, idempotency and one active analysis/workspace.

## Risk 7 — Purge failure

**Risk:** permanent deletion may leave derived residues.

**Mitigation:** idempotent Purge Worker, retries and Sentry.

---

# 75. Open Review Markers

The following are intentionally fixed for MVP but marked for reassessment during implementation/testing:

1. **Similarity threshold = 0.75**
2. **Maximum 20 document versions per analysis**
3. **Credit formula**
4. **Credit package quantities**
5. **Free 50-credit grant**
6. **Cerebras/Groq free-tier availability and limits**
7. **Potential Azure account with available credits**
8. **Signed URL duration ≈ 5 minutes**
9. **Daily digest time = 23:00 UTC**

Changes to these should not alter the core product model.

---

# 76. Post-MVP Roadmap Candidates

Only after the academic MVP is complete and, if applicable, real user validation exists:

- Notion connector.
- Google Drive connector.
- SharePoint connector.
- Confluence connector.
- URL ingestion.
- OCR.
- custom categories.
- scheduled recurring analysis.
- recommended comparison documents.
- suppression of repeated findings.
- false-positive learning.
- comments.
- export.
- custom notification preferences.
- user timezones.
- multiple workspaces.
- SSO.
- advanced billing.
- refunds.
- workspace deletion.
- enterprise data residency.
- Azure/OpenAI enterprise provider.
- richer dashboards.
- real commercial pilots.

---

# 77. Definition of MVP Success

For this academic project, success is not defined as product-market fit or revenue.

The MVP is successful when the team can demonstrate a stable end-to-end product where:

1. private documents are securely ingested;
2. documents are preprocessed and embedded;
3. a user explicitly chooses analysis scope;
4. credits are estimated and reserved;
5. the system asynchronously detects contradiction/obsolescence candidates;
6. findings display evidence;
7. QA performs human review;
8. findings can be assigned;
9. a Member submits a correction;
10. QA approves/rejects;
11. a new active version can be reanalyzed manually;
12. tenant isolation is tested;
13. permanent deletion removes document-derived data;
14. critical flows are observable and testable;
15. the product remains within the defined 12-week scope.

---

# 78. Final Product Statement

Knowledge Decay Monitor MVP is a focused document-quality SaaS for software startups.

Its objective is not to replace the organization’s documentation platform. Its objective is to answer a narrower and more actionable question:

> **Can the team still trust what its internal documents say?**

The MVP answers that question by combining semantic retrieval, AI-assisted contradiction/obsolescence detection, visible evidence and a controlled human remediation workflow, while keeping tenant isolation, intellectual-property protection and predictable credit consumption at the center of the design.

The roadmap must preserve that focus throughout all six vertical slices.
