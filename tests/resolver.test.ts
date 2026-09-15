import { expect, it, vi } from 'vitest'
import { SafeResolver } from '../src/resolver.js'
import { resolveConfig } from '../src/config.js'
import { fake, real, signal } from './helpers.js'
import type { Lookup } from '../src/ip-policy.js'

function setup(input = {}) {
  let now = 1000
  const lookup = vi.fn<Lookup>(async () => [fake()])
  const validate = vi.fn(async () => ({ addresses: [real()], expiresAt: now + 60000 }))
  const resolver = new SafeResolver(resolveConfig(input), { lookup, doh: { validate }, now: () => now })
  return { resolver, lookup, validate, tick: (ms: number) => { now += ms } }
}

it('fresh system DNS and the current fake-IP are used on cache hits', async () => {
  const s = setup()
  expect(await s.resolver.resolve('example.com', signal())).toEqual([fake()])
  s.lookup.mockResolvedValue([fake('198.18.0.99')])
  expect(await s.resolver.resolve('EXAMPLE.COM.', signal())).toEqual([fake('198.18.0.99')])
  expect(s.validate).toHaveBeenCalledTimes(1)
  expect(s.lookup).toHaveBeenCalledTimes(2)
})

it('revalidates after TTL and applies the configured cap', async () => {
  const s = setup({ maxValidationTtlMs: 1000 })
  await s.resolver.resolve('example.com', signal())
  s.tick(1000)
  await s.resolver.resolve('example.com', signal())
  expect(s.validate).toHaveBeenCalledTimes(2)
})

it('does not cache zero TTL or failures', async () => {
  const s = setup({ maxValidationTtlMs: 0 })
  await s.resolver.resolve('example.com', signal())
  await s.resolver.resolve('example.com', signal())
  expect(s.validate).toHaveBeenCalledTimes(2)
  s.validate.mockRejectedValueOnce(new Error('DoH offline'))
  await expect(s.resolver.resolve('example.com', signal())).rejects.toThrow('offline')
  await s.resolver.resolve('example.com', signal())
  expect(s.validate).toHaveBeenCalledTimes(4)
})

it('public system DNS skips DoH', async () => {
  const s = setup()
  s.lookup.mockResolvedValue([real()])
  expect(await s.resolver.resolve('example.com', signal())).toEqual([real()])
  expect(s.validate).not.toHaveBeenCalled()
})

it('accepts the Mihomo default fake-IP IPv4 and IPv6 pools in one answer', async () => {
  const s = setup()
  const entries = [fake('198.18.1.47'), { address: 'fdfe:dcba:9876::12c', family: 6 as const }]
  s.lookup.mockResolvedValue(entries)
  expect(await s.resolver.resolve('example.com', signal())).toEqual(entries)
  expect(s.validate).toHaveBeenCalledTimes(1)
})

it('names the non-public address that falls outside the fake-IP pool', async () => {
  const s = setup()
  s.lookup.mockResolvedValue([fake('198.18.1.47'), { address: 'fd00:6152::1', family: 6 }])
  await expect(s.resolver.resolve('example.com', signal())).rejects.toThrow(/fd00:6152::1/)
})

it.each([{ entries: [fake(), real()] }, { entries: [fake(), fake('127.0.0.1')] }, { entries: [fake('169.254.169.254')] }])('blocks unsafe sets even with cached validation: %j', async ({ entries }) => {
  const s = setup()
  await s.resolver.resolve('example.com', signal())
  s.lookup.mockResolvedValue(entries)
  await expect(s.resolver.resolve('example.com', signal())).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
})

it.each(['127.0.0.1', '198.18.0.1', '[::1]', '[::ffff:127.0.0.1]'])('never rescues IP literal %s', async host => {
  const s = setup()
  await expect(s.resolver.resolve(host, signal())).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  expect(s.lookup).not.toHaveBeenCalled()
  expect(s.validate).not.toHaveBeenCalled()
})

it('validates the whole DoH result at the resolver boundary', async () => {
  const s = setup()
  s.validate.mockResolvedValue({ addresses: [real(), fake('10.0.0.1')], expiresAt: 10000 })
  await expect(s.resolver.resolve('example.com', signal())).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
})

it('bounds the success LRU at 1024 entries', async () => {
  const s = setup()
  for (let n = 0; n < 1024; n++) await s.resolver.resolve(`h${n}.example.com`, signal())
  await s.resolver.resolve('h0.example.com', signal()) // refresh recency
  await s.resolver.resolve('h1024.example.com', signal())
  await s.resolver.resolve('h0.example.com', signal())
  expect(s.validate).toHaveBeenCalledTimes(1025)
  await s.resolver.resolve('h1.example.com', signal())
  expect(s.validate).toHaveBeenCalledTimes(1026)
})

it('cancels a hanging OS lookup and closes disposed instances', async () => {
  const s = setup()
  s.lookup.mockImplementation(() => new Promise(() => {}))
  const controller = new AbortController()
  const pending = s.resolver.resolve('example.com', controller.signal)
  controller.abort(new Error('cancelled'))
  await expect(pending).rejects.toThrow('cancelled')
  s.resolver.dispose()
  await expect(s.resolver.resolve('example.com', signal())).rejects.toThrow('disposed')
})

it('only logs when enabled', async () => {
  const log = vi.fn()
  const deps = { lookup: async () => [real()], log }
  await new SafeResolver(resolveConfig(), deps).resolve('example.com', signal())
  expect(log).not.toHaveBeenCalled()
  await new SafeResolver(resolveConfig({ debug: true }), deps).resolve('example.com', signal())
  expect(log).toHaveBeenCalledWith('example.com: public DNS')
})

it('supports IPv6 fake pools and revalidates DoH IPv6 against active DNS64', async () => {
  const lookup: Lookup = vi.fn(async host => host === 'ipv4only.arpa'
    ? [{ address: '2001:4860:abcd::c000:aa', family: 6 }]
    : [{ address: 'fd00:6152::1', family: 6 }])
  const validate = vi.fn(async () => ({ addresses: [{ address: '2606:4700:4700::1111', family: 6 as const }], expiresAt: 0 }))
  const resolver = new SafeResolver(resolveConfig({ fakeIpCidrs: ['fd00:6152::/32'] }), { lookup, doh: { validate } })
  expect(await resolver.resolve('example.com', signal())).toEqual([{ address: 'fd00:6152::1', family: 6 }])
  validate.mockResolvedValue({ addresses: [{ address: '2001:4860:abcd::a00:1', family: 6 }], expiresAt: 0 })
  await expect(resolver.resolve('example.com', signal())).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
})
