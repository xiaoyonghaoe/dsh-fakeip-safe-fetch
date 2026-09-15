import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Exercise the real published provider, but make its Undici seam mockable.
    server: { deps: { inline: [/@deepseek-ai\/dsh-web-fetch-http/] } },
    testTimeout: 10000,
  },
})
