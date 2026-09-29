import { test, expect } from "@playwright/test";
import { loginAs } from "./auth.helper";

test.describe("Flujo Repositorio y Acceso Seguro (S1-05)", () => {
    test.beforeEach(async ({ context }) => {
        await loginAs(context, "admin.a@example.test");
    });
    test("Admin puede consultar el repositorio y abrir un archivo", async ({ page, context }) => {
        // 1. Acceder al repositorio
        await page.goto("/repository");

        // 2. Verificar que se renderice la interfaz desktop-first del repositorio
        await expect(page.getByRole("heading", { name: "Repositorio" })).toBeVisible();
        await expect(page.getByRole("table")).toBeVisible();

        // 3. Verificar que las columnas requeridas existan
        await expect(page.getByRole("columnheader", { name: "Documento" })).toBeVisible();
        await expect(page.getByRole("columnheader", { name: "Categoría" })).toBeVisible();
        await expect(page.getByRole("columnheader", { name: "Propietario" })).toBeVisible();
        await expect(page.getByRole("columnheader", { name: "Versión" })).toBeVisible();
        await expect(page.getByRole("columnheader", { name: "Estado" })).toBeVisible();
        await expect(page.getByRole("columnheader", { name: "Acciones" })).toBeVisible();

        // 4. Si hay documentos disponibles, probar el botón de abrir
        const openButtons = page.getByRole("button", { name: /Abrir archivo/i });
        const count = await openButtons.count();

        if (count > 0) {
            const firstButton = openButtons.first();

            // Esperar el evento de apertura de nueva pestaña
            const pagePromise = context.waitForEvent("page");
            await firstButton.click();
            const newPage = await pagePromise;

            // Comprobar que la nueva pestaña cargue o apunte a una URL con token firmado
            await expect(newPage).toHaveURL(/token=/);
        }
    });

    test("Badge de estado visualiza correctamente las versiones", async ({ page }) => {
        await page.goto("/repository");

        // Verificar que los badges rendericen estilos y etiquetas semánticas
        const readyBadge = page.locator("text=Listo").first();
        if (await readyBadge.isVisible()) {
            await expect(readyBadge).toHaveClass(/bg-emerald-50/);
        }
    });
});