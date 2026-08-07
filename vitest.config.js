import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests run against PGlite (Postgres compiled to WASM) since the Neon
    // migration. Restoring a database from the cached template is fast, but the
    // process that builds that template first pays for initdb, which is well
    // over vitest's 5s default.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
