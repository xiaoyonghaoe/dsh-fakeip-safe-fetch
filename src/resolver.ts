import { lookup as systemLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { WebError } from '@deepseek-ai/dsh-web'
import type { HttpFetchResolver } from '@deepseek-ai/dsh-web-fetch-http'
import type { ResolvedConfig } from './config.js'
import { DohClient, canonicalName, type ValidationResult } from './doh.js'
import { assertPublicAddresses, isFakeIp, isPublicIp, parseCidrs, stripBrackets, validateAddressShape, type Lookup } from './ip-policy.js'
import { withSignal } from './abort.js'

export interface Validator { validate(host: string, signal: AbortSignal): Promise<ValidationResult> }
export interface ResolverDependencies { lookup?: Lookup; doh?: Validator; now?: () => number; log?: (message: string) => void }

/** Each plugin instance owns a bounded success-only LRU. OS DNS is never cached here. */
export class SafeResolver {
  private readonly lookup: Lookup
  private readonly doh: Validator
  private readonly now: () => number
  private readonly cidrs
  private readonly cache = new Map<string, number>()
  private readonly lifecycle = new AbortController()

  constructor(private readonly config: ResolvedConfig, private readonly dependencies: ResolverDependencies = {}) {
    this.lookup = dependencies.lookup ?? systemLookup
    this.now = dependencies.now ?? Date.now
    this.doh = dependencies.doh ?? new DohClient(config, undefined, this.now)
    this.cidrs = parseCidrs(config.fakeIpCidrs)
  }

  dispose(): void { this.cache.clear(); this.lifecycle.abort(new Error('fakeip-safe provider disposed')) }

  readonly resolve: HttpFetchResolver = async (hostname, callerSignal) => {
    const signal = AbortSignal.any([callerSignal, this.lifecycle.signal])
    signal.throwIfAborted()
    const rawHost = stripBrackets(hostname)
    const literal = isIP(rawHost)
    const entries = validateAddressShape(literal
      ? [{ address: rawHost, family: literal }]
      : await withSignal(this.lookup(rawHost, { all: true, order: 'verbatim' }), signal))
    if (entries.every(entry => isPublicIp(entry.address))) {
      await assertPublicAddresses(entries, this.lookup, signal)
      this.log(`${hostname}: public DNS`)
      return entries
    }
    if (literal || !entries.every(entry => !isPublicIp(entry.address) && isFakeIp(entry.address, this.cidrs))) {
      throw new WebError('DNS answer is non-public or mixes public and fake-IP addresses', 'WEB_BLOCKED_URL')
    }
    const key = canonicalName(rawHost)
    const expiry = this.cache.get(key)
    if (expiry !== undefined) {
      this.cache.delete(key)
      if (expiry > this.now()) {
        this.cache.set(key, expiry)
        this.log(`${key}: fake-IP; validation cache hit`)
        return entries
      }
    }
    this.log(`${key}: fake-IP; validating through DoH`)
    const result = await this.doh.validate(key, signal)
    // Validate again at the policy boundary, including active custom DNS64 prefixes.
    await assertPublicAddresses(validateAddressShape(result.addresses), this.lookup, signal)
    signal.throwIfAborted()
    const expiresAt = Math.min(result.expiresAt, this.now() + this.config.maxValidationTtlMs)
    if (expiresAt > this.now()) {
      this.cache.delete(key)
      this.cache.set(key, expiresAt)
      if (this.cache.size > 1024) this.cache.delete(this.cache.keys().next().value!)
    }
    this.log(`${key}: DoH validated; cache TTL ${Math.max(0, expiresAt - this.now())} ms`)
    return entries
  }

  private log(message: string): void { if (this.config.debug) this.dependencies.log?.(message) }
}
