import { defineConfig } from 'vitest/config'

// skills/ holds unit tests: pure logic through fakes, runs anywhere. test/ drives the
// built bundle against a local mock of the Live API, so it needs a build + ffmpeg.
export default defineConfig({
  test: {
    include: ['skills/realtime-translator/src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
})
