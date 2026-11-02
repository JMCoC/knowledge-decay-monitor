import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures";
import { createAnalysisFixture } from "../support/analysis-fixtures";
import { cleanupLocalUser, newLocalUser } from "../support/local-supabase";

const terminalStatuses = ["completed", "failed"] as const;

for (const status of terminalStatuses) {
  test(`returns an anonymous ${status} notification link to its exact analysis`, async ({ page }) => {
    const fixture = await createAnalysisFixture({ status });
    try {
      await page.goto(`/login?analysisId=${fixture.analysisId}`);
      await page.getByLabel("Email address").fill(fixture.adminCredentials.email);
      await page.getByLabel("Password", { exact: true }).fill(fixture.adminCredentials.password);
      await page.getByRole("button", { name: "Sign in" }).click();

      await expect(page).toHaveURL(new RegExp(`/analysis/${fixture.analysisId}$`));
      await expect(page.getByRole("heading", { name: status === "completed" ? "Completed" : "Failed" })).toBeVisible();

      await page.goto(`/login?analysisId=${fixture.analysisId}`);
      await expect(page).toHaveURL(new RegExp(`/analysis/${fixture.analysisId}$`));
    } finally {
      await fixture.dispose();
    }
  });
}

test("keeps the standard app destination when an analysis query is repeated", async ({ page }) => {
  const fixture = await createAnalysisFixture({ status: "completed" });
  try {
    await page.goto(`/login?analysisId=${fixture.analysisId}&analysisId=${fixture.analysisId}`);
    await page.getByLabel("Email address").fill(fixture.adminCredentials.email);
    await page.getByLabel("Password", { exact: true }).fill(fixture.adminCredentials.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("heading", { name: "Your knowledge, in one place." })).toBeVisible();
  } finally {
    await fixture.dispose();
  }
});

test("keeps the notification link available when credentials are rejected", async ({ page }) => {
  const fixture = await createAnalysisFixture({ status: "completed" });
  try {
    await page.goto(`/login?analysisId=${fixture.analysisId}`);
    await page.getByLabel("Email address").fill(fixture.adminCredentials.email);
    await page.getByLabel("Password", { exact: true }).fill("incorrect-synthetic-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(new RegExp(`/login\\?analysisId=${fixture.analysisId}$`));
    await expect(page.getByRole("alert")).toBeVisible();
  } finally {
    await fixture.dispose();
  }
});

test("onboarding keeps priority over an analysis continuation", async ({ page }) => {
  const fixture = await createAnalysisFixture({ status: "completed" });
  const user = await newLocalUser();
  try {
    await page.goto(`/login?analysisId=${fixture.analysisId}`);
    await page.getByLabel("Email address").fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Create your organization’s workspace" })).toBeVisible();
  } finally {
    await cleanupLocalUser(user.userId);
    await fixture.dispose();
  }
});

test("a Member following an analysis link receives a controlled permission error", async ({ page }) => {
  const fixture = await createAnalysisFixture({ status: "completed" });
  try {
    await page.goto(`/login?analysisId=${fixture.analysisId}`);
    await page.getByLabel("Email address").fill(fixture.memberCredentials.email);
    await page.getByLabel("Password", { exact: true }).fill(fixture.memberCredentials.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(new RegExp(`/analysis/${fixture.analysisId}$`));
    await expect(page.locator("main").getByRole("alert")).toContainText(
      "You don't have permission to perform document analysis.",
    );
    await expect(page.locator("main")).not.toContainText("Synthetic analysis finding");
    await expect(page.locator("main")).not.toContainText("Synthetic analysis evidence snapshot");
  } finally {
    await fixture.dispose();
  }
});

test("a foreign-tenant link and a nonexistent analysis stay controlled and private", async ({ page }) => {
  const ownFixture = await createAnalysisFixture({ status: "completed" });
  const foreignFixture = await createAnalysisFixture({ status: "completed" });
  try {
    await page.goto(`/login?analysisId=${foreignFixture.analysisId}`);
    await page.getByLabel("Email address").fill(ownFixture.adminCredentials.email);
    await page.getByLabel("Password", { exact: true }).fill(ownFixture.adminCredentials.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(new RegExp(`/analysis/${foreignFixture.analysisId}$`));
    await expect(page.locator("main").getByRole("alert")).toContainText("This analysis is unavailable.");
    await expect(page.locator("main")).not.toContainText("Synthetic analysis finding");
    await expect(page.locator("main")).not.toContainText("Synthetic analysis evidence snapshot");

    await page.goto(`/analysis/${randomUUID()}`);
    await expect(page.locator("main").getByRole("alert")).toContainText("This analysis is unavailable.");
    await expect(page.locator("main")).not.toContainText("Synthetic analysis finding");
    await expect(page.locator("main")).not.toContainText("Synthetic analysis evidence snapshot");
  } finally {
    await foreignFixture.dispose();
    await ownFixture.dispose();
  }
});
