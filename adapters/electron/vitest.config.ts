import { defineConfig } from 'vitest/config';

process.env['ALLURE_LABEL_epic'] ??= 'electron';

export default defineConfig({
  // Vitest resolves `test.include` against the process cwd unless told
  // otherwise; `npm run test:electron` invokes this config from the repo
  // root via `--config`, so `root` must point back at this directory.
  root: import.meta.dirname,
  test: {
    globals: true,
    testTimeout: 10_000,
    include: ['__tests__/**/*.test.ts'],
    setupFiles: ['allure-vitest/setup'],
    reporters: [
      'default',
      [
        'allure-vitest/reporter',
        {
          resultsDir: '../../allure-results/electron',
        },
      ],
    ],
  },
});
