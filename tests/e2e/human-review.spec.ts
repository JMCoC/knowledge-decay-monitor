import { expect, test } from "./fixtures";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { loginAs } from "./auth.helper";

test.describe("S3-03 human review", () => {
  test.describe.configure({ mode: "serial" });

  test("competing reviewers refresh the winning revision before continuing", async ({ page, context, browser }) => {
    const fixture = await createAnalysisFixture({ status: "completed", versionCount: 2 });
    const competingContext = await browser.newContext();
    try {
      await loginAs(context, fixture.qaCredentials.email, fixture.qaCredentials.password);
      await page.goto(`/analysis/${fixture.analysisId}/findings?findingId=${fixture.findingId}`);
      const firstReviewer = page.getByRole("dialog", { name: "Evidence & Document Comparison" });
      await expect(firstReviewer.getByRole("button", { name: "Confirm" })).toBeVisible();

      const competingPage = await competingContext.newPage();
      await loginAs(competingContext, fixture.adminCredentials.email, fixture.adminCredentials.password);
      await competingPage.goto(`/analysis/${fixture.analysisId}/findings?findingId=${fixture.findingId}`);
      const secondReviewer = competingPage.getByRole("dialog", { name: "Evidence & Document Comparison" });
      await expect(secondReviewer.getByRole("combobox", { name: "Current: High" })).toHaveValue("High");
      await secondReviewer.getByRole("combobox", { name: "Current: High" }).selectOption("Low");
      await expect(secondReviewer.getByRole("combobox", { name: "Current: Low" })).toHaveValue("Low");

      await firstReviewer.getByRole("button", { name: "Confirm" }).click();
      await expect(firstReviewer.getByRole("alert")).toContainText("modified by another reviewer");
      await expect(firstReviewer.getByRole("combobox", { name: "Current: Low" })).toHaveValue("Low");
      await expect(firstReviewer.getByRole("button", { name: "Confirm" })).toBeVisible();
    } finally {
      await competingContext.close();
      await fixture.dispose();
    }
  });

  test("QA reviews, assigns and opens an explicit document round; Member remains forbidden", async ({ page, context }) => {
    const fixture = await createAnalysisFixture({ status: "completed", versionCount: 2 });
    try {
      const actionBodies: string[] = [];
      const responseBodyReads: Promise<void>[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (request.headers()["next-action"] || /\/analysis\/[^/]+\/findings$/.test(path)) {
          actionBodies.push(request.postData() ?? "");
        }
      });
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (response.request().headers()["next-action"] || /\/analysis\/[^/]+\/findings$/.test(path)) {
          responseBodyReads.push(response.text().then((body) => {
            actionBodies.push(body);
          }).catch(() => {
            /* Response intentionally dropped during retry case. */
          }));
        }
      });

      const [firstVersion] = fixture.versions;
      const secondVersion = fixture.versions[1];
      if (!firstVersion || !secondVersion) throw new Error("The review fixture needs two document versions.");
      await fixture.sql.query(`
        insert into public.finding_evidence(
          workspace_id, analysis_id, finding_id, document_id, version_id, chunk_id,
          section, section_heading, snapshot
        ) values (
          '${fixture.workspaceId}'::uuid, '${fixture.analysisId}'::uuid,
          '${fixture.findingId}'::uuid, '${secondVersion.documentId}'::uuid,
          '${secondVersion.versionId}'::uuid, '${secondVersion.chunkId}'::uuid,
          'Fixture', 'Additional evidence', 'Second document evidence'
        );
        with false_positive as (insert into public.findings(
          workspace_id, analysis_id, type, severity_original, severity_current,
          confidence, explanation, status, assignee_id, fingerprint
        ) values (
          '${fixture.workspaceId}'::uuid, '${fixture.analysisId}'::uuid,
          'obsolescence', 'Low', 'Low', 0.51, 'False positive workflow fixture',
          'pending_review', null, gen_random_uuid()::text
        ) returning id)
        insert into public.finding_evidence(
          workspace_id, analysis_id, finding_id, document_id, version_id, chunk_id,
          section, section_heading, snapshot
        ) select '${fixture.workspaceId}'::uuid, '${fixture.analysisId}'::uuid, false_positive.id,
          '${firstVersion.documentId}'::uuid, '${firstVersion.versionId}'::uuid, '${firstVersion.chunkId}'::uuid,
          'Fixture', 'False positive', 'Synthetic false positive evidence'
        from false_positive;
      `);

      await loginAs(context, fixture.qaCredentials.email, fixture.qaCredentials.password);
      await page.goto(`/analysis/${fixture.analysisId}`);
      await expect(page.getByRole("heading", { name: "Completed" })).toBeVisible();
      await page.getByRole("link", { name: "View Analysis Findings" }).click();
      await expect(page).toHaveURL(`/analysis/${fixture.analysisId}/findings`);
      await expect(page.getByRole("heading", { name: "Analysis Findings & Evidence" })).toBeVisible();
      await page.getByRole("combobox", { name: "Severity" }).selectOption("High");
      await expect(page).toHaveURL(/severity=High/);
      const findingRow = page.locator("tbody tr").filter({ hasText: "Synthetic analysis finding" });
      await findingRow.getByRole("button", { name: /View Evidence/ }).click();
      const drawer = page.getByRole("dialog", { name: "Evidence & Document Comparison" });
      await expect(drawer.getByText("AI Proposed: High")).toBeVisible();
      await expect(drawer.getByRole("button", { name: "Confirm" })).toBeVisible();
      await expect(drawer.getByRole("button", { name: /Resolve/ })).toHaveCount(0);

      let dropFirstActionResponse = true;
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (dropFirstActionResponse && request.method() === "POST" && request.headers()["next-action"]) {
          dropFirstActionResponse = false;
          const persisted = await route.fetch();
          expect(persisted.ok()).toBeTruthy();
          await route.abort();
          return;
        }
        await route.continue();
      });
      await drawer.getByRole("button", { name: "Confirm" }).click();
      await expect(drawer.getByRole("alert")).toContainText("response was lost");
      await drawer.getByRole("button", { name: "Confirm" }).click();
      await expect(drawer.getByRole("button", { name: "Plan Update" })).toBeVisible();
      await page.unroute("**/*");

      await drawer.getByRole("combobox", { name: "Current: High" }).selectOption("Medium");
      await expect(drawer.getByRole("combobox", { name: "Current: Medium" })).toHaveValue("Medium");
      await expect(page.getByText("No findings match your selected filters")).toBeVisible();
      await drawer.getByRole("button", { name: "Close evidence panel" }).click();
      await page.getByRole("button", { name: "Clear filters" }).first().click();
      await expect(page).toHaveURL(`/analysis/${fixture.analysisId}/findings`);

      await findingRow.getByRole("button", { name: /View Evidence/ }).click();
      const refreshedDrawer = page.getByRole("dialog", { name: "Evidence & Document Comparison" });
      await expect(refreshedDrawer.getByRole("combobox", { name: "Current: Medium" })).toHaveValue("Medium");
      const assignee = refreshedDrawer.getByRole("combobox", { name: "Assignee" });
      await expect(assignee.locator(`option[value="${fixture.memberId}"]`)).toHaveCount(1);
      await assignee.selectOption(fixture.memberId);
      await expect(assignee).toHaveValue(fixture.memberId);
      await expect(findingRow).toContainText("Medium");
      await expect(findingRow).toContainText("AI: High");
      await expect(findingRow).toContainText("Synthetic Analysis Member");

      await refreshedDrawer.getByRole("button", { name: "Close evidence panel" }).click();
      await expect(refreshedDrawer).toHaveCount(0);
      await page.locator("#filter-assignee").selectOption(fixture.memberId);
      await expect(page).toHaveURL(new RegExp(`assignee=${fixture.memberId}`));
      await expect(findingRow).toBeVisible();
      await expect(findingRow).toContainText("Synthetic Analysis Member");
      await page.getByRole("button", { name: "Clear filters" }).click();
      await expect(page).toHaveURL(new RegExp(`/analysis/${fixture.analysisId}/findings$`));
      await findingRow.getByRole("button", { name: /View Evidence/ }).click();
      const roundDrawer = page.getByRole("dialog", { name: "Evidence & Document Comparison" });

      await roundDrawer.getByRole("combobox", { name: "Document to correct" }).selectOption(secondVersion.documentId);
      await roundDrawer.getByRole("button", { name: "Prepare Correction Round" }).click();
      const round = page.getByRole("dialog", { name: "Prepare correction round" });
      await expect(round).toContainText("Synthetic analysis finding");
      await expect(round).toContainText("Future findings will require a new round");
      await expect(round.getByRole("button", { name: "Prepare round" })).toBeEnabled();
      await round.getByRole("button", { name: "Prepare round" }).click();
      await round.getByRole("button", { name: "Open round" }).click();
      await expect(roundDrawer.getByText("Correction round opened. Its finding set is now fixed.")).toBeVisible();
      await expect(page.getByText(/Future findings will require a new round/)).toHaveCount(0);
      await roundDrawer.getByRole("button", { name: "Close evidence panel" }).click();
      await expect(roundDrawer).toHaveCount(0);

      const falsePositiveRow = page.locator("tbody tr").filter({ hasText: "False positive workflow fixture" });
      await falsePositiveRow.getByRole("button", { name: /View Evidence/ }).click();
      const falsePositiveDrawer = page.getByRole("dialog", { name: "Evidence & Document Comparison" });
      await falsePositiveDrawer.getByRole("button", { name: "Mark as False Positive" }).click();
      await expect(falsePositiveDrawer.getByRole("button", { name: "Resolve Manually" })).toBeVisible();
      await falsePositiveDrawer.getByRole("button", { name: "Resolve Manually" }).click();
      await expect(falsePositiveDrawer.getByText("Resolved", { exact: true })).toBeVisible();
      await expect(falsePositiveDrawer.locator("[data-testid='finding-review-actions'] button")).toHaveCount(0);

      await Promise.all(responseBodyReads);
      expect(actionBodies.join("\n").toLowerCase()).not.toContain("confidence");
      expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("confidence");
      expect((await page.locator("html").evaluate((element) => element.outerHTML)).toLowerCase()).not.toContain("confidence");

      await context.clearCookies();
      await loginAs(context, fixture.memberCredentials.email, fixture.memberCredentials.password);
      const memberResponse = await page.goto(`/analysis/${fixture.analysisId}/findings`);
      expect(memberResponse?.status()).toBe(404);
      await expect(page.getByRole("button", { name: "Confirm" })).toHaveCount(0);
    } finally {
      await fixture.dispose();
    }
  });
});
