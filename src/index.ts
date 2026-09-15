import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import { FakeIpSafeFetchProvider } from './provider.js'

export { Config, defaults, resolveConfig } from './config.js'
export type { ResolvedConfig } from './config.js'
export { FakeIpSafeFetchProvider, FETCH_PROVIDER_ID } from './provider.js'
export const name = 'web-fetch-fakeip-safe'
export const inject = ['web']

export function apply(ctx: Context, config: Config = {}): void {
  const provider = new FakeIpSafeFetchProvider(config, { log: message => ctx.logger('fakeip-safe').debug(message) })
  ctx.effect(() => () => provider.dispose(), 'fakeip-safe lifecycle')
  ctx.web.registerFetchProvider(provider)
}
