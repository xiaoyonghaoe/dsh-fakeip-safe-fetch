import { HttpFetchProvider, DEFAULT_USER_AGENT } from '@deepseek-ai/dsh-web-fetch-http'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { WebError, type WebFetchProvider, type WebFetchRequest, type WebFetchResult } from '@deepseek-ai/dsh-web'
import { resolveConfig, type Config } from './config.js'
import { SafeResolver, type ResolverDependencies } from './resolver.js'

export const FETCH_PROVIDER_ID = 'fakeip-safe'

export class FakeIpSafeFetchProvider implements WebFetchProvider {
  readonly id = FETCH_PROVIDER_ID
  private readonly delegate: HttpFetchProvider
  private readonly resolver: SafeResolver
  private readonly lifecycle = new AbortController()

  constructor(config: Config = {}, dependencies: ResolverDependencies = {}) {
    const resolved = resolveConfig(config)
    this.resolver = new SafeResolver(resolved, dependencies)
    this.delegate = new HttpFetchProvider({ ...resolved, userAgent: DEFAULT_USER_AGENT }, this.resolver.resolve)
  }

  available(): boolean { return !this.lifecycle.signal.aborted }
  dispose(): void { this.lifecycle.abort(); this.resolver.dispose() }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (this.lifecycle.signal.aborted || signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    // Upstream owns complete URL validation. Parsing here is only for the proxy guard.
    let url: URL | undefined
    try { url = new URL(request.url) } catch { /* Delegate reports WEB_INVALID_URL. */ }
    if (url && (url.protocol === 'https:' || url.protocol === 'http:') && proxyRouteFor(url).proxied) {
      throw new WebError('fakeip-safe supports TUN only; remove the explicit proxy route for this origin and restart DSH', 'WEB_BLOCKED_URL')
    }
    return this.delegate.fetch(request, signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal)
  }
}
