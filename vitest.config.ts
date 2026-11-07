import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Examples type-check against src/ but are standalone apps: their tests
    // import the published entry points from an installed package.
    exclude: [...configDefaults.exclude, "examples/**"],
  },
});
