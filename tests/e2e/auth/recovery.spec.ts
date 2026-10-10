import { randomUUID } from "node:crypto";
import { expect, test } from "../fixtures";
import { waitForRecoveryLink, tokenHashFromRecoveryLink } from "../../../scripts/mailpit.mjs";
import { registerThroughUi } from "../../support/auth-ui";
import { expireLocalRecoveryToken, newLocalUser } from "../../support/local-supabase";

async function safeOriginPath(page: import("@playwright/test").Page) {
  const url = new URL(page.url());
  return `${url.origin}${url.pathname}`;
}

test("expired and malformed recovery tokens do not create a session", async ({ page }) => {
  const { client, email, userId } = await newLocalUser();
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: "http://127.0.0.1:3000/auth/callback",
  });
  if (error) throw new Error("Local Auth rejected the synthetic recovery request.");

  const link = await waitForRecoveryLink(email);
  tokenHashFromRecoveryLink(link);
  expireLocalRecoveryToken(userId);

  try {
    await page.goto(link);
  } catch {
    throw new Error("Expired recovery callback navigation failed.");
  }
  await expect.poll(() => safeOriginPath(page)).toBe("http://127.0.0.1:3000/forgot-password");
  const authCookies = () => page.context().cookies().then((cookies) => cookies.filter((cookie) => cookie.name.startsWith("sb-")));
  await expect.poll(authCookies).toEqual([]);

  try {
    await page.goto(`/auth/callback?token_hash=malformed-${randomUUID()}&type=recovery`);
  } catch {
    throw new Error("Malformed recovery callback navigation failed.");
  }
  await expect.poll(() => safeOriginPath(page)).toBe("http://127.0.0.1:3000/forgot-password");
  await expect.poll(authCookies).toEqual([]);
});

test("recovery works in another browser, survives reload, and preserves its session after link replay", async ({ browser, page }) => {
  const email = `kdm-${randomUUID()}@example.test`;
  const oldPassword = `Kdm-${randomUUID()}`;
  const newPassword = `Kdm-${randomUUID()}`;

  await registerThroughUi(page, email, oldPassword);
  await page.getByLabel("Your name").fill("KDM Recovery Admin");
  await page.getByLabel("Workspace name").fill(`kdm-${randomUUID()}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.goto("/forgot-password");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send reset instructions" }).click();
  await expect(page.getByText("If an account exists for this email, you will receive password reset instructions.")).toBeVisible();

  const link = await waitForRecoveryLink(email);
  const tokenHash = tokenHashFromRecoveryLink(link);
  const recoveryContext = await browser.newContext();
  const recoveryPage = await recoveryContext.newPage();

  try {
    try {
      await recoveryPage.goto(link);
    } catch {
      throw new Error("Recovery callback navigation failed.");
    }
    await expect.poll(() => safeOriginPath(recoveryPage)).toBe("http://127.0.0.1:3000/reset-password");
    await recoveryPage.reload();
    await expect(recoveryPage.getByLabel("New password", { exact: true })).toBeVisible();
    await recoveryPage.getByLabel("New password", { exact: true }).fill(newPassword);
    await recoveryPage.getByLabel("Confirm new password", { exact: true }).fill(newPassword);
    await recoveryPage.getByRole("button", { name: "Update password" }).click();
    await expect(recoveryPage.getByText("Your password has been updated. Continue to your account.")).toBeVisible();

    const consumedResponsePage = await recoveryContext.newPage();
    try {
      await consumedResponsePage.goto(link);
    } catch {
      throw new Error("Consumed recovery callback navigation failed.");
    }
    await expect.poll(() => safeOriginPath(consumedResponsePage)).toBe("http://127.0.0.1:3000/forgot-password");
    await recoveryPage.goto("/reset-password");
    await expect(recoveryPage.getByLabel("New password", { exact: true })).toBeVisible();
    await consumedResponsePage.close();
  } finally {
    await recoveryContext.close();
  }

  const cleanContext = await browser.newContext();
  const cleanPage = await cleanContext.newPage();
  try {
    await cleanPage.goto("/login");
    await cleanPage.getByLabel("Email address").fill(email);
    await cleanPage.getByLabel("Password", { exact: true }).fill(oldPassword);
    await cleanPage.getByRole("button", { name: "Sign in" }).click();
    await expect(cleanPage.getByText("Invalid email or password.", { exact: true })).toBeVisible();

    await cleanPage.getByLabel("Password", { exact: true }).fill(newPassword);
    await cleanPage.getByRole("button", { name: "Sign in" }).click();
    await expect(cleanPage).toHaveURL(/\/app$/);
  } finally {
    await cleanContext.close();
  }

  expect(tokenHash.length).toBeGreaterThan(0);
});
