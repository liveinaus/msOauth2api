import { defineConfig } from "vitest/config";
import os from "node:os";
import path from "node:path";

export default defineConfig({
  test: {
    env: {
      // The database module opens (and creates) its file at import time, so anything that
      // reaches it would otherwise leave a stray db in the repo. Point it at a temp path.
      DB_PATH: path.join(os.tmpdir(), "msoauth2api-test", "test.db"),
      JWT_SECRET: "test-secret-not-a-known-placeholder",
    },
  },
});
