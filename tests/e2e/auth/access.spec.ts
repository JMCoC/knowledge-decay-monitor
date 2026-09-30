import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { insertMemberProfile, newLocalUser } from "../../support/local-supabase";
import { loginThroughUi } from "../../support/auth-ui";

test("private routes reject an anonymous visitor and ignore an external callback destination", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);

  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/login$/);

  await page.goto("/reset-password");
  await expect(page).toHaveURL(/\/forgot-password\?error=invalid-link$/);

  await page.goto("/auth/callback?token_hash=synthetic-invalid&type=signup&next=https%3A%2F%2Fexample.org");
  await expect(page).toHaveURL(/\/forgot-password\?error=invalid-link$/);
  expect(new URL(page.url()).origin).toBe("http://127.0.0.1:3000");
});

test("a Member sees the workspace home without a Repository navigation entry", async ({ page }) => {
  const admin = await newLocalUser();
  const marker = `kdm-${randomUUID()}`;
  const { data: workspaceId, error } = await admin.client.rpc("bootstrap_workspace", {
    workspace_name: marker,
    full_name: "KDM Test Admin",
  });
  if (error || !workspaceId) throw new Error("Could not create the local Member fixture workspace.");

  const member = await newLocalUser();
  insertMemberProfile({
    userId: member.userId,
    workspaceId,
    fullName: "KDM Test Member",
    email: member.email,
  });

  await loginThroughUi(page, member.email, member.password);
  await expect(page.getByRole("heading", { name: "Your knowledge, in one place." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Repository" })).toHaveCount(0);
});

test("a session without Auth cookies cannot renew access to the private workspace", async ({ page }) => {
  const admin = await newLocalUser();
  const { error } = await admin.client.rpc("bootstrap_workspace", {
    workspace_name: `kdm-${randomUUID()}`,
    full_name: "KDM Expired Session Admin",
  });
  if (error) throw new Error("Could not create the local expired-session fixture.");

  await loginThroughUi(page, admin.email, admin.password);
  await expect(page).toHaveURL(/\/app$/);
  await page.context().clearCookies();
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
});
