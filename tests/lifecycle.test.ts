import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import * as plugin from '../src/index.js'
import { FakeIpSafeFetchProvider } from '../src/provider.js'

it('registers, recreates on config changes, disposes and unregisters with Cordis', async () => {
  const ctx = new Context()
  const dispose = vi.spyOn(FakeIpSafeFetchProvider.prototype, 'dispose')
  await ctx.plugin(WebRuntime, { fetchProvider: 'fakeip-safe' })
  const fiber = await ctx.plugin(plugin, {})
  try {
    await expect(ctx.web.fetch({ url: 'http://127.0.0.1/' })).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    await fiber.update({ maxValidationTtlMs: 0 })
    expect(dispose).toHaveBeenCalledTimes(1)
    await expect(ctx.web.fetch({ url: 'http://127.0.0.1/' })).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    await fiber.dispose()
    expect(dispose).toHaveBeenCalledTimes(2)
    await expect(ctx.web.fetch({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  } finally { dispose.mockRestore(); await ctx.fiber.dispose() }
})
