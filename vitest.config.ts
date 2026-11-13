import { allowedNodeEnvironmentFlags } from 'node:process';
import { defineConfig } from 'vitest/config';

const disableWebStorageFlag = '--no-webstorage';

export default defineConfig({
  test: {
    execArgv: allowedNodeEnvironmentFlags.has(disableWebStorageFlag) ? [disableWebStorageFlag] : [],
    name: 'provider-firefox',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
