import { expect, test } from "./fixtures";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { loginAs } from "./auth.helper";
import { loginThroughUi } from "../support/auth-ui";

test.describe("S2-09 analysis confirmation, recovery, status, and retry", () => {
  test.describe.configure({ mode: "serial" });

  test("replays a lost confirmation after reload without creating a second run or reservation", async ({ page, context }) => {
    const fixture = await createAnalysisFixture({ versionCount: 2, status: "completed" });
    try {
      await loginAs(context, fixture.adminCredentials.email, fixture.adminCredentials.password);
      await page.goto("/analysis/run");
      const sources = page.getByRole("checkbox", { name: /^Select Analysis fixture / });
      await expect(sources.first()).toBeVisible();
      await sources.first().check();
      await page.getByRole("button", { name: "Calculate Estimated Cost" }).click();
      await expect(page.getByText(/Estimated cost: \d+ credits/)).toBeVisible();
      await page.getByRole("button", { name: "Proceed to Run Analysis" }).click();
      const firstConfirmation = page.getByRole("dialog", { name: "Confirm analysis" });
      await expect(firstConfirmation).toBeVisible();
      await expect(firstConfirmation.getByText(/Estimated cost: \d+ credits/)).toBeVisible();
      await firstConfirmation.getByRole("button", { name: "Cancel" }).click();
      await sources.nth(1).check();
      await expect(page.getByRole("button", { name: "Calculate Estimated Cost" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Proceed to Run Analysis" })).toBeDisabled();
      await page.getByRole("button", { name: "Calculate Estimated Cost" }).click();
      await expect(page.getByText(/Estimated cost: \d+ credits/)).toBeVisible();
      await page.getByRole("button", { name: "Proceed to Run Analysis" }).click();
      const confirmation = page.getByRole("dialog", { name: "Confirm analysis" });
      await expect(confirmation.getByText(/Estimated cost: \d+ credits/)).toBeVisible();

      let loseFirstResponse = true;
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (loseFirstResponse && request.method() === "POST" && request.headers()["next-action"]) {
          loseFirstResponse = false;
          const [first, duplicate] = await Promise.all([route.fetch(), route.fetch()]);
          expect(first.ok()).toBeTruthy();
          expect(duplicate.ok()).toBeTruthy();
          await route.abort();
          return;
        }
        await route.continue();
      });

      await confirmation.getByRole("button", { name: "Confirm and run" }).click();
      await expect(confirmation.getByRole("alert")).toContainText("Retry this confirmation to safely recover it.");
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem("pending-analysis-run")))
        .toMatch(/estimateRef.*idempotencyKey/);

      await page.reload();
      await expect(page).toHaveURL(/\/analysis\/[0-9a-f-]{36}$/i, { timeout: 30_000 });
      await expect(page.getByRole("heading", { name: /Queued|Processing|Completed|Failed/ })).toBeVisible();
      await page.unroute("**/*");

      const analysisCount = await fixture.sql.query(
        `select count(*)::text from public.analyses where workspace_id = '${fixture.workspaceId}'::uuid;`,
      );
      const reservationCount = await fixture.sql.query(
        `select count(*)::text from public.credit_ledger where workspace_id = '${fixture.workspaceId}'::uuid and event_type = 'Reserved';`,
      );
      expect(analysisCount.trim()).toBe("2");
      expect(reservationCount.trim()).toBe("1");
      expect(await page.evaluate(() => sessionStorage.getItem("pending-analysis-run"))).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  test("restores the same persisted analysis after logout and sign-in", async ({ page, context }) => {
    const fixture = await createAnalysisFixture({ status: "queued" });
    try {
      await loginAs(context, fixture.qaCredentials.email, fixture.qaCredentials.password);
      await page.goto(`/analysis/${fixture.analysisId}`);
      await expect(page.getByRole("heading", { name: "Queued" })).toBeVisible();
      await expect(page.getByText("Synthetic analysis fixture chunk", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page).toHaveURL(/\/login$/);

      await loginThroughUi(page, fixture.qaCredentials.email, fixture.qaCredentials.password);
      await expect(page).toHaveURL(/\/app$/);
      await page.goto(`/analysis/${fixture.analysisId}`);
      await expect(page.getByRole("heading", { name: "Queued" })).toBeVisible();
      await expect(page.getByText("Synthetic analysis fixture chunk", { exact: true })).toHaveCount(0);

      const analysisCount = await fixture.sql.query(
        `select count(*)::text from public.analyses where workspace_id = '${fixture.workspaceId}'::uuid;`,
      );
      expect(analysisCount.trim()).toBe("1");
    } finally {
      await fixture.dispose();
    }
  });

  test("renders persisted Processing and Completed states without exposing chunk text", async ({ page, context }) => {
    const processing = await createAnalysisFixture({ status: "processing" });
    const completed = await createAnalysisFixture({ status: "completed" });
    try {
      await loginAs(context, processing.qaCredentials.email, processing.qaCredentials.password);
      await page.goto(`/analysis/${processing.analysisId}`);
      await expect(page.getByRole("heading", { name: "Processing" })).toBeVisible();
      await expect(page.getByText("Synthetic analysis fixture chunk", { exact: true })).toHaveCount(0);

      await context.clearCookies();
      await loginAs(context, completed.qaCredentials.email, completed.qaCredentials.password);
      await page.goto(`/analysis/${completed.analysisId}`);
      await expect(page.getByRole("heading", { name: "Completed" })).toBeVisible();
      await expect(page.getByText("Analysis completed. Findings will be available when the findings experience is delivered.")).toBeVisible();
      await expect(page.getByText("Synthetic analysis fixture chunk", { exact: true })).toHaveCount(0);
    } finally {
      await completed.dispose();
      await processing.dispose();
    }
  });

  test("requires explicit cost confirmation before retry and preserves the failed run", async ({ page, context }) => {
    const fixture = await createAnalysisFixture({ status: "failed", withLedger: true });
    try {
      await loginAs(context, fixture.qaCredentials.email, fixture.qaCredentials.password);
      await page.goto(`/analysis/${fixture.analysisId}`);
      await expect(page.getByRole("heading", { name: "Failed" })).toBeVisible();
      await expect(page.locator("main").getByRole("alert")).toContainText("This analysis failed.");
      await page.getByRole("button", { name: "Retry Analysis" }).click();

      const confirmation = page.getByRole("dialog", { name: "Confirm analysis retry" });
      await expect(confirmation).toBeVisible();
      await expect(confirmation.getByText(/Estimated cost: \d+ credits/)).toBeVisible();
      await expect(confirmation.getByRole("button", { name: "Confirm and retry" })).toBeEnabled();
      await confirmation.getByRole("button", { name: "Confirm and retry" }).click();
      await page.waitForURL((url) => url.pathname !== `/analysis/${fixture.analysisId}`, { timeout: 30_000 });
      await expect(page).toHaveURL(/\/analysis\/[0-9a-f-]{36}$/i);

      const retriedId = new URL(page.url()).pathname.split("/").at(-1);
      expect(retriedId).toMatch(/^[0-9a-f-]{36}$/i);
      const relation = await fixture.sql.query(
        `select retry_of_analysis_id::text from public.analyses where id = '${retriedId}'::uuid;`,
      );
      const original = await fixture.sql.query(
        `select status::text from public.analyses where id = '${fixture.analysisId}'::uuid;`,
      );
      const releaseCount = await fixture.sql.query(
        `select count(*)::text from public.credit_ledger where analysis_id = '${fixture.analysisId}'::uuid and event_type = 'Released';`,
      );
      expect(relation.trim()).toBe(fixture.analysisId);
      expect(original.trim()).toBe("failed");
      expect(releaseCount.trim()).toBe("1");
    } finally {
      await fixture.dispose();
    }
  });

  test("lets a Member see the balance but denies own and cross-tenant analysis details", async ({ page, context }) => {
    const fixture = await createAnalysisFixture({ status: "completed" });
    const foreignFixture = await createAnalysisFixture({ status: "completed" });
    try {
      await loginAs(context, fixture.memberCredentials.email, fixture.memberCredentials.password);
      await page.goto("/credits");
      await expect(page.getByRole("heading", { name: "Billing / Credits" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Credit balance" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Recent credit activity" })).toHaveCount(0);
      const directLedger = await fixture.member.rpc("list_credit_ledger", { p_page: 1, p_page_size: 25 });
      expect(directLedger.data).toBeNull();
      expect(directLedger.error?.code).toBe("42501");

      await page.goto(`/analysis/${fixture.analysisId}`);
      await expect(page.locator("main").getByRole("alert")).toContainText("You don't have permission to perform document analysis.");
      await page.goto(`/analysis/${foreignFixture.analysisId}`);
      await expect(page.locator("main").getByRole("alert")).toContainText("You don't have permission to perform document analysis.");
    } finally {
      await foreignFixture.dispose();
      await fixture.dispose();
    }
  });
});
