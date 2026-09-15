import z from '@deepseek-ai/schemastery'
import { isIP } from 'node:net'
import { parseCidrs, isPublicIp, stripBrackets } from './ip-policy.js'

export interface Config {
  fakeIpCidrs?: string[]
  dohUrl?: string
  dohTimeoutMs?: number
  maxValidationTtlMs?: number
  maxResponseBytes?: number
  maxBodyChars?: number
  timeoutMs?: number
  maxRedirects?: number
  debug?: boolean
}

export type ResolvedConfig = Readonly<Omit<Required<Config>, 'fakeIpCidrs'>> & { readonly fakeIpCidrs: readonly string[] }

export const defaults: ResolvedConfig = Object.freeze({
  fakeIpCidrs: Object.freeze(['198.18.0.0/15']),
  dohUrl: 'https://dns.google/dns-query',
  dohTimeoutMs: 5000,
  maxValidationTtlMs: 300000,
  maxResponseBytes: 5000000,
  maxBodyChars: 100000,
  timeoutMs: 30000,
  maxRedirects: 5,
  debug: false,
})

export const Config: z<Config> = z.object({
  fakeIpCidrs: z.array(z.string()).default([...defaults.fakeIpCidrs]),
  dohUrl: z.string().default(defaults.dohUrl),
  dohTimeoutMs: z.number().default(defaults.dohTimeoutMs),
  maxValidationTtlMs: z.number().default(defaults.maxValidationTtlMs),
  maxResponseBytes: z.number().default(defaults.maxResponseBytes),
  maxBodyChars: z.number().default(defaults.maxBodyChars),
  timeoutMs: z.number().default(defaults.timeoutMs),
  maxRedirects: z.number().default(defaults.maxRedirects),
  debug: z.boolean().default(defaults.debug),
})

/** Also fill defaults for programmatic users that do not invoke Schemastery. */
export function resolveConfig(input: Config = {}): ResolvedConfig {
  const config = { ...defaults, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as ResolvedConfig
  if (!Array.isArray(config.fakeIpCidrs) || config.fakeIpCidrs.some(c => typeof c !== 'string')) throw new Error('fakeIpCidrs must be an array of CIDRs')
  parseCidrs(config.fakeIpCidrs)
  let url: URL
  try { url = new URL(config.dohUrl) } catch { throw new Error('dohUrl must be an absolute HTTPS URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('dohUrl must use HTTPS without credentials or fragment')
  if (isIP(stripBrackets(url.hostname)) && !isPublicIp(url.hostname)) throw new Error('dohUrl must not name a non-public IP literal')
  for (const key of ['dohTimeoutMs', 'timeoutMs', 'maxResponseBytes', 'maxBodyChars'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive safe integer`)
  }
  for (const key of ['maxValidationTtlMs', 'maxRedirects'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 0) throw new Error(`${key} must be a non-negative safe integer`)
  }
  for (const key of ['dohTimeoutMs', 'timeoutMs'] as const) {
    if (config[key] > 2147483647) throw new Error(`${key} exceeds the Node timer range`)
  }
  if (typeof config.debug !== 'boolean') throw new Error('debug must be a boolean')
  return Object.freeze({ ...config, fakeIpCidrs: Object.freeze([...config.fakeIpCidrs]), dohUrl: url.href })
}
