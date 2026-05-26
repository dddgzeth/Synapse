import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, ".")
    }
  },
  server: {
    host: "127.0.0.1"
  },
  test: {
    environment: "jsdom",
    globals: true,
    environmentOptions: {
      jsdom: {
        url: "http://127.0.0.1/"
      }
    },
    setupFiles: [
      "./vitest.setup.ts"
    ],
    include: [
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx"
    ]
  }
});
