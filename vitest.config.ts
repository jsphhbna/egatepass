import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': import.meta.dirname + '/src',
    },
  },
  test: {
    testTimeout: 120_000,
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    env: {
      VITE_TURNSTILE_SITE_KEY: '0x4AAAAAAFeETebgPENH6hgH',
    },
  },
});
