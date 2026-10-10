import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["tests/runtime/ingestion-image.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
