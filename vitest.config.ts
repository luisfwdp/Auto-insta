import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // Next resolves this build marker itself. Node-only tests have no client
      // bundle; the actual boundary is enforced by the production Next build.
      "server-only": path.resolve(__dirname, "__tests__/fixtures/server-only.ts"),
    },
  },
});
