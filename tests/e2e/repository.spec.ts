import { test, expect } from "@playwright/test";
import { loginAs } from "./auth.helper";

test.describe("Repository access", () => {
    test("Admin can list documents and open a confirmed original", async ({ page, context }) => {
        await loginAs(context, "admin.a@example.test");
        await page.goto("/repository");

        await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
        await expect(page.getByRole("table")).toBeVisible();

        await expect(page.getByRole("columnheader", { name: "Document" })).toBeVisible();
        await expect(page.getByRole("columnheader", { name: "Category" })).toBeVisible();
        await expect(page.getByRole("columnheader", { name: "Owner" })).toBeVisible();
        await expect(page.getByRole("columnheader", { name: "Version" })).toBeVisible();
        await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
        await expect(page.getByRole("columnheader", { name: "Actions" })).toBeVisible();

        const openButtons = page.getByRole("button", { name: /Open file/i });
        await expect(openButtons).not.toHaveCount(0);
        const openedPagePromise = context.waitForEvent("page");
        const navigationResponsePromise = context.waitForEvent("response", (response) =>
            response.request().isNavigationRequest() && response.status() === 200,
        );
        await openButtons.first().click();
        const openedPage = await openedPagePromise;
        const response = await navigationResponsePromise;
        const bytes = await response.body();

        expect(bytes.byteLength > 0).toBe(true);
        await openedPage.close();
    });

    test("renders a controlled Repository upload or processing status", async ({ page }) => {
        await loginAs(page.context(), "admin.a@example.test");
        await page.goto("/repository");

        await expect(page.getByText(
            /^(No version|Needs reconciliation|Upload incomplete|Verifying|Upload rejected|Recovering|Uploaded — processing pending|Ready|Processing|Processing failed)$/,
        ).first()).toBeVisible();
    });

    test("shows a controlled message when the browser blocks the new tab", async ({ page }) => {
        await loginAs(page.context(), "admin.a@example.test");
        await page.addInitScript(() => {
            window.open = () => null;
        });
        await page.goto("/repository");

        await page.getByRole("button", { name: /Open file/i }).first().click();

        await expect(page.getByText(
            "Your browser blocked the new tab. Allow pop-ups and try again.",
            { exact: true },
        )).toBeVisible();
    });

    test("shows a controlled support reference when the open action response is lost", async ({ page, context }) => {
        await loginAs(context, "admin.a@example.test");
        await page.goto("/repository");
        await page.route("**/*", async (route) => {
            const request = route.request();
            if (request.method() === "POST" && request.headers()["next-action"]) {
                await route.abort();
                return;
            }
            await route.continue();
        });

        await page.getByRole("button", { name: /Open file/i }).first().click();

        const alert = page.getByRole("alert").filter({
            hasText: "We couldn't confirm the operation. Refresh and try again.",
        });
        await expect(alert).toContainText("We couldn't confirm the operation. Refresh and try again.");
        await expect(alert).toContainText(/Reference: [0-9a-f-]{36}/i);
    });

    test("Workspace B cannot see Workspace A documents", async ({ page, context }) => {
        await loginAs(context, "admin.b@example.test");
        await page.goto("/repository");

        await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
        await expect(page.getByText("Private policy B", { exact: true })).toBeVisible();
        await expect(page.getByText("Incident response", { exact: true })).toHaveCount(0);
        await expect(page.getByText("Engineering handbook", { exact: true })).toHaveCount(0);
        await expect(page.getByText("Recovery drill", { exact: true })).toHaveCount(0);
    });

    test("Member cannot see Repository rows or upload controls even when Owner", async ({ page, context }) => {
        await loginAs(context, "member.a@example.test");
        await page.goto("/repository");

        await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
        await expect(page.getByText("You don't have permission to access documents.", { exact: true })).toBeVisible();
        await expect(page.getByRole("table")).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Upload documents" })).toHaveCount(0);
        await expect(page.getByText("Incident response", { exact: true })).toHaveCount(0);
    });
});
