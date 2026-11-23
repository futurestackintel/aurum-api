
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  if (migrations.length === 0) {
    throw new Error("No D1 migrations were found in ./migrations");
  }

  return {
    test: {
     setupFiles: ["./test/setup.js"],
			testTimeout: 30_000,
       poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
