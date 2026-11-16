# S3-03 Human Review & Assignment Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the human review UI, severity override, member assignment, and round preparation controls for QA Leads and Admins on analysis findings without leaking internal AI confidence.

**Architecture:** Extend the existing findings view and evidence drawer with dedicated, decoupled review components under `src/modules/review/ui/` (`SeverityControl`, `FindingReviewActions`, `AssigneeSelector`, and `RoundPreparationModal`). These components consume public server actions from `@/modules/review`, handle optimistic concurrency via `revision` and `idempotencyKey`, and manage conflicts without overwriting peer decisions.

**Tech Stack:** Next.js App Router (React 19 Server Actions & Client Components), TypeScript strict mode, Tailwind CSS v4, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-15-s3-03-human-review-findings-design.md`

## Global Constraints

- Use strictly the public server actions exported from `@/modules/review`: `changeFinding`, `assignFinding`, `listAssignees`, `getFindingReview`, `prepareRound`, `openRound`.
- `severityOriginal` is immutable; `severityCurrent` is mutable. Sorting and filtering in the UI operate on `severityCurrent`.
- Finding transitions: `pending_review` → `confirmed` | `false_positive`; `confirmed` → `update_planned` | `resolved`; `false_positive` / `update_planned` → `resolved`. Prohibit jumping directly from `pending_review` to `resolved`. `resolved` is terminal.
- Assignment requires status `confirmed` or `update_planned`. Assigning a finding never opens a round automatically; opening a round is an explicit action.
- Every mutation must supply `revision` and a unique `idempotencyKey` (`crypto.randomUUID()`). On `CONFLICT` error (409), display non-blocking warning and refresh state without losing other reviewers' decisions.
- Absolutely zero leakage of `confidence` score in DOM attributes, rendered markup, client logs, or telemetry.
- Server-side RBAC: only `Admin` and `QA Lead` can execute mutations; `Member` role receives `FORBIDDEN`.

## Review Focus

1. **State jump prevention:** A finding in `pending_review` must not render a `Resolve` action button under any condition.
2. **AI severity preservation:** Overriding current severity to `Medium` when AI proposed `High` must keep `severityOriginal` visible alongside the updated `severityCurrent`.
3. **Multi-document clarity:** When a finding's evidence spans multiple documents, `AssigneeSelector` must show an explicit hint identifying which document must be corrected.
4. **Optimistic concurrency recovery:** When a mutation receives `CONFLICT`, the UI must display a controlled conflict notice and reload the latest review snapshot instead of crashing or showing false success.
5. **Zero confidence leakage:** No HTML element, data attribute, or text node rendered by review components may contain `confidence`.

---

### Task 1: Severity Control Component (`SeverityControl`)

**Files:**
- Create: `src/modules/review/ui/severity-control.tsx`
- Test: `src/modules/review/ui/severity-control.test.tsx`

**Interfaces:**
- Consumes: `FindingSeverity` from `@/types/contracts`, `changeFinding` from `@/modules/review`.
- Produces: `SeverityControl` component accepting `findingId: string`, `severityOriginal: FindingSeverity`, `severityCurrent: FindingSeverity`, `revision: number`, `canChangeSeverity: boolean`, `onUpdated?: (updated: FindingReviewSnapshot) => void`.

- [x] **Step 1: Write failing unit test for `SeverityControl`**

Create `src/modules/review/ui/severity-control.test.tsx` using `renderToStaticMarkup` from `react-dom/server`:
- Verifies display of immutable `AI Proposed: High` and selector for `Current: High | Medium | Low`.
- Verifies that when `canChangeSeverity` is false, selector is disabled or rendered as static text.
- Verifies zero leakage: rendered HTML string must not contain `confidence`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/modules/review/ui/severity-control.test.tsx`
Expected: FAIL with module not found.

- [x] **Step 3: Implement `SeverityControl` in `src/modules/review/ui/severity-control.tsx`**

Implement Client Component:
- Displays AI original severity badge (`AI: ${severityOriginal}`).
- Renders `<select>` or button group for `Current: ${severityCurrent}`.
- Handles `onChange` calling `changeFinding({ findingId, revision, idempotencyKey: crypto.randomUUID(), change: { field: "severity", value } })` within `useTransition`.
- Disables interaction while `isPending` or when `canChangeSeverity === false`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test src/modules/review/ui/severity-control.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/review/ui/severity-control.tsx src/modules/review/ui/severity-control.test.tsx
git commit -m "feat(review): implement SeverityControl component with immutable AI severity"
```

---

### Task 2: Finding Review Actions Component (`FindingReviewActions`)

**Files:**
- Create: `src/modules/review/ui/finding-review-actions.tsx`
- Test: `src/modules/review/ui/finding-review-actions.test.tsx`

**Interfaces:**
- Consumes: `ReviewFindingStatus`, `FindingReviewSnapshot` from `@/types/review-contracts`, `changeFinding` from `@/modules/review`.
- Produces: `FindingReviewActions` component accepting `findingId: string`, `status: ReviewFindingStatus`, `revision: number`, `canChangeStatus: boolean`, `onUpdated?: (updated: FindingReviewSnapshot) => void`.

- [x] **Step 1: Write failing unit test for `FindingReviewActions`**

Create `src/modules/review/ui/finding-review-actions.test.tsx`:
- Status `pending_review`: renders "Confirm" and "Mark as False Positive"; does NOT render "Resolve".
- Status `confirmed`: renders "Plan Update" and "Resolve Manually".
- Status `false_positive`: renders "Resolve Manually".
- Status `update_planned`: renders "Resolve Manually".
- Status `resolved`: renders "Resolved" badge with no action buttons.
- Verifies zero leakage: rendered HTML string must not contain `confidence`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/modules/review/ui/finding-review-actions.test.tsx`
Expected: FAIL with module not found.

- [x] **Step 3: Implement `FindingReviewActions` in `src/modules/review/ui/finding-review-actions.tsx`**

Implement Client Component:
- Renders buttons according to the current `status` and `canChangeStatus`.
- Calls `changeFinding({ findingId, revision, idempotencyKey: crypto.randomUUID(), change: { field: "status", value: targetStatus } })`.
- Disables buttons when `isPending`.
- Emits `onUpdated` on success.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test src/modules/review/ui/finding-review-actions.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/review/ui/finding-review-actions.tsx src/modules/review/ui/finding-review-actions.test.tsx
git commit -m "feat(review): implement FindingReviewActions with strict status transitions"
```

---

### Task 3: Assignee Selector Component (`AssigneeSelector`)

**Files:**
- Create: `src/modules/review/ui/assignee-selector.tsx`
- Test: `src/modules/review/ui/assignee-selector.test.tsx`

**Interfaces:**
- Consumes: `EligibleOwner` from `@/types/contracts`, `assignFinding`, `listAssignees` from `@/modules/review`.
- Produces: `AssigneeSelector` component accepting `findingId: string`, `currentAssignee: EligibleOwner | null`, `revision: number`, `canAssign: boolean`, `affectedDocuments: { documentId: string; name: string }[]`, `onUpdated?: (updated: FindingReviewSnapshot) => void`.

- [x] **Step 1: Write failing unit test for `AssigneeSelector`**

Create `src/modules/review/ui/assignee-selector.test.tsx`:
- When `canAssign === false`: displays current assignee as read-only or placeholder.
- When `canAssign === true`: renders member selector with "Unassigned" option.
- When `affectedDocuments.length > 1`: renders helper message indicating which document to select for correction.
- Verifies zero leakage: rendered HTML string must not contain `confidence`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/modules/review/ui/assignee-selector.test.tsx`
Expected: FAIL with module not found.

- [x] **Step 3: Implement `AssigneeSelector` in `src/modules/review/ui/assignee-selector.tsx`**

Implement Client Component:
- Loads assignees using `listAssignees()` on mount or dropdown focus.
- Selecting a member calls `assignFinding({ findingId, revision, assigneeId: memberId, idempotencyKey: crypto.randomUUID() })`.
- Selecting "Unassigned" calls `assignFinding` with `assigneeId: null`.
- Displays multi-document guidance when `affectedDocuments.length > 1`.
- Disables interaction while `isPending` or when `canAssign === false`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test src/modules/review/ui/assignee-selector.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/review/ui/assignee-selector.tsx src/modules/review/ui/assignee-selector.test.tsx
git commit -m "feat(review): implement AssigneeSelector with multi-document guidance"
```

---

### Task 4: Round Preparation Modal (`RoundPreparationModal`)

**Files:**
- Create: `src/modules/review/ui/round-preparation-modal.tsx`
- Test: `src/modules/review/ui/round-preparation-modal.test.tsx`

**Interfaces:**
- Consumes: `FindingReviewSnapshot`, `ReviewRound` from `@/types/review-contracts`, `prepareRound`, `openRound` from `@/modules/review`.
- Produces: `RoundPreparationModal` component accepting `isOpen: boolean`, `documentId: string`, `documentName: string`, `findings: FindingReviewSnapshot[]`, `onClose: () => void`, `onRoundOpened: (round: ReviewRound) => void`.

- [x] **Step 1: Write failing unit test for `RoundPreparationModal`**

Create `src/modules/review/ui/round-preparation-modal.test.tsx`:
- When `isOpen === false`: returns null.
- When `isOpen === true`: displays document name, list of findings to be included, explanation that opening locks the finding set, and action buttons.
- Verifies zero leakage: rendered HTML string must not contain `confidence`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/modules/review/ui/round-preparation-modal.test.tsx`
Expected: FAIL with module not found.

- [x] **Step 3: Implement `RoundPreparationModal` in `src/modules/review/ui/round-preparation-modal.tsx`**

Implement Client Component modal:
- Step 1: Calls `prepareRound({ documentId, mode: "assigned_findings", findingIds: [findingIds...], idempotencyKey: crypto.randomUUID() })`.
- Step 2: Displays summary of draft round.
- Step 3: Button to open round calling `openRound({ roundId, revision, idempotencyKey: crypto.randomUUID() })`.
- Disables submit buttons during `isPending` transitions.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test src/modules/review/ui/round-preparation-modal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/review/ui/round-preparation-modal.tsx src/modules/review/ui/round-preparation-modal.test.tsx
git commit -m "feat(review): implement RoundPreparationModal for explicit round opening"
```

---

### Task 5: Integrate Review Controls into Drawer and Findings List

**Files:**
- Modify: `src/modules/analysis/ui/finding-evidence-drawer.tsx`
- Modify: `src/modules/analysis/ui/findings-view.tsx`
- Modify: `src/modules/analysis/ui/finding-evidence-drawer.test.tsx`
- Modify: `src/modules/analysis/ui/findings-view.test.tsx`

**Interfaces:**
- Integrates: `SeverityControl`, `FindingReviewActions`, `AssigneeSelector`, `RoundPreparationModal` into existing analysis views.
- Handles `CONFLICT` error: displays warning banner and triggers snapshot re-fetch via `getFindingReview({ findingId })`.

- [x] **Step 1: Write drawer integration and reviewer-conflict coverage**

Update `src/modules/analysis/ui/finding-evidence-drawer.test.tsx` to verify:
- Drawer renders `SeverityControl` showing current severity and AI severity.
- Drawer renders `FindingReviewActions` showing allowed status actions.
- Drawer renders `AssigneeSelector`.
- When an action triggers a CONFLICT error, an accessible alert banner is displayed.
- Zero leakage check across full drawer markup.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/modules/analysis/ui/finding-evidence-drawer.test.tsx`
Expected: FAIL.

- [x] **Step 3: Implement integration in `finding-evidence-drawer.tsx` and `findings-view.tsx`**

- In `finding-evidence-drawer.tsx`:
  - Add section for review decisions: severity override, assignment, and status transition.
  - Implement optimistic concurrency conflict recovery: state for `conflictWarning`, on conflict catch invoke `getFindingReview({ findingId })` to refresh data and revision.
- In `findings-view.tsx`:
  - Display `severityCurrent` badge; if different from `severityOriginal`, show secondary indicator `(AI: ${severityOriginal})`.
  - Display assigned member full name or "Unassigned".
  - Add "Prepare Correction Round" button opening `RoundPreparationModal` for documents with confirmed findings.

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/modules/analysis/ui/finding-evidence-drawer.test.tsx src/modules/analysis/ui/findings-view.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/analysis/ui/finding-evidence-drawer.tsx src/modules/analysis/ui/findings-view.tsx src/modules/analysis/ui/finding-evidence-drawer.test.tsx src/modules/analysis/ui/findings-view.test.tsx
git commit -m "feat(review): integrate review controls and conflict handling into findings drawer and view"
```

---

### Task 6: E2E and Quality Gate Verification for S3-03

**Files:**
- Create: `tests/e2e/human-review.spec.ts`

**Interfaces:**
- Validates: End-to-end user workflows for QA Lead and Member access control.

- [x] **Step 1: Implement E2E test scenarios in `tests/e2e/human-review.spec.ts`**

Scenarios:
1. QA Lead opens finding in `pending_review`, clicks "Confirm", overrides severity to "Medium", and assigns to a workspace Member.
2. Verify list displays updated severity and assignee.
3. Verify Member role receives forbidden response when attempting review mutations.
4. Verify no `confidence` token is exposed anywhere in network responses or DOM.

- [x] **Step 2: Run full unit test suite, typecheck, and lint**

Run:
```bash
pnpm typecheck
pnpm lint
pnpm test:unit
```
Expected: PASS without errors or type violations.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/human-review.spec.ts
git commit -m "test(review): add E2E integration test for S3-03 human review workflow"
```
