import { defineConfig } from 'vitest/config';

// The console's own runner. The core suite excludes `console/**` so its file
// and case counts are the ones it reported before this package existed, which
// is what issue #27 asks for.
//
// No global setup and no container: every case here is pure. The console owns
// no SQL, so what there is to test is the rendering and the one write's
// delegation, and both take a stub.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
