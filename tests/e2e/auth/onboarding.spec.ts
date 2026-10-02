import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { loginThroughUi, registerThroughUi } from "../../support/auth-ui";

test("registration, interrupted onboarding, bootstrap, reload, logout and login", async ({ page }) => {
  const suffix = randomUUID();
  const email = `kdm-${suffix}@example.test`;
  const password = `Kdm-${randomUUID()}`;
  const workspaceName = `kdm-${suffix}`;

  await registerThroughUi(page, email, password);
  await expect(page.getByLabel("Your name")).toBeVisible();

  // A session lost between visits must resume onboarding after a normal login.
  await page.context().clearCookies();
  await loginThroughUi(page, email, password);
  await expect(page.getByLabel("Workspace name")).toBeVisible();

  await page.getByLabel("Your name").fill("KDM Test Admin");
  await page.getByLabel("Workspace name").fill(workspaceName);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Your knowledge, in one place." })).toBeVisible();
  await expect(page.getByText(workspaceName)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your knowledge, in one place." })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await loginThroughUi(page, email, password);
  await expect(page).toHaveURL(/\/app$/);
});
