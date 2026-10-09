import { expect, test } from "./fixtures";
import { loginAs } from "./auth.helper";

test.describe("Repository search and filters", () => {
  test("shows an empty page when the requested page is beyond the tenant's results", async ({ page, context }) => {
    await loginAs(context, "admin.a@example.test");
    await page.goto("/repository?page=99");

    await expect(page.getByRole("region", { name: "Repository filters" })).toBeVisible();
    await expect(page.getByText("No documents on this page.", { exact: true })).toBeVisible();
    await expect(page.getByText("We couldn't load the Repository.", { exact: true })).toHaveCount(0);
  });

  test("debounces name search, shows a contextual empty state, and clears filters", async ({ page, context }) => {
    await loginAs(context, "admin.a@example.test");
    await page.goto("/repository");

    const search = page.getByRole("textbox", { name: "Search by name" });
    await expect(search).toHaveValue("");
    await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);

    await search.fill("no matching repository document");
    await expect(page).toHaveURL((url) => url.searchParams.get("name") === "no matching repository document");
    await expect(page.getByText("No documents found", { exact: true })).toBeVisible();
    await expect(page.getByText("No documents match the selected filters.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear filters" })).toBeVisible();

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/repository" && url.search === "");
    await expect(search).toHaveValue("");
    await expect(page.getByText("Incident response", { exact: true })).toBeVisible();
  });

  test("applies category, owner, and version state filters to the URL immediately", async ({ page, context }) => {
    await loginAs(context, "admin.a@example.test");
    await page.goto("/repository?page=3&pageSize=1");

    const category = page.getByRole("combobox", { name: "Category" });
    await category.selectOption("SOP");
    await expect(page).toHaveURL((url) => url.searchParams.get("category") === "SOP" && !url.searchParams.has("page"));
    await expect(page.getByText("Incident response", { exact: true })).toBeVisible();
    await expect(page.getByText("Engineering handbook", { exact: true })).toHaveCount(0);

    const owner = page.getByRole("combobox", { name: "Owner" });
    await expect(owner.locator("option")).toContainText(["All owners", "Unassigned", "Admin A", "Member A", "QA Lead A"]);
    await expect(owner.locator("option", { hasText: "Admin B" })).toHaveCount(0);
    await owner.selectOption("10000000-0000-4000-8000-000000000003");
    await expect(page).toHaveURL((url) => url.searchParams.get("ownerId") === "10000000-0000-4000-8000-000000000003");
    await expect(page.getByText("Incident response", { exact: true })).toBeVisible();

    await page.getByRole("combobox", { name: "Version state" }).selectOption("not_active");
    await expect(page).toHaveURL((url) => url.searchParams.get("versionStatus") === "not_active");
    await expect(page.getByRole("button", { name: "Clear filters" })).toBeVisible();
  });

  test("filters processing and not active initial versions", async ({ page, context }) => {
    await loginAs(context, "admin.a@example.test");
    await page.goto("/repository");

    await page.getByRole("combobox", { name: "Version state" }).selectOption("not_active");
    await expect(page).toHaveURL((url) => url.searchParams.get("versionStatus") === "not_active");
    await expect(page.getByText("Engineering handbook", { exact: true })).toBeVisible();
    await expect(page.getByText("Recovery drill", { exact: true })).toBeVisible();
    await expect(page.getByText("Incident response", { exact: true })).toHaveCount(0);
  });
});
