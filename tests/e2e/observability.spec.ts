import { expect, test } from "./fixtures";

test.describe("observability diagnostics guard", () => {
  test("does not render diagnostic controls for an unauthenticated visitor", async ({ page }) => {
    await page.goto("/sentry-example-page");

    await expect(page.getByRole("status")).toHaveText("Diagnostic access is unavailable.");
    await expect(page.getByRole("button", { name: "Test browser reporting" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Test server reporting" })).toHaveCount(0);
  });

  test("the legacy example API is closed without generating an error", async ({ request }) => {
    const response = await request.get("/api/sentry-example-api");

    expect(response.status()).toBe(404);
    expect(await response.text()).toBe("");
  });
});
