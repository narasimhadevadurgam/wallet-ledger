import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Integration suites run against ONE shared Postgres. Run every test file
    // serially in a single worker so no two suites migrate or mutate the DB at
    // the same time (which otherwise races on CREATE TABLE / pg_type and lets
    // one suite's data leak into another). `singleThread` keeps a single
    // worker thread; `fileParallelism: false` forbids running files in
    // parallel. This is cross-platform (threads pool) and valid for Vitest
    // 2.1.x.
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    fileParallelism: false,
  },
});
