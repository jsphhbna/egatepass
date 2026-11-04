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
      RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-hmac-secret-at-least-32-chars!',
      RETURNING_MATCH_TOKEN_SECRET: 'test-returning-match-secret-at-least-32-chars!',
      PASS_TOKEN_SECRET: 'test-pass-token-secret-at-least-32-chars!',
      RETURNING_VISITOR_TEMPLATE_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
  },
});
