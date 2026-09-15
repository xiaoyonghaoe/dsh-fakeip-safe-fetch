import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FakeIpSafeFetchProvider } from '../src/provider.js'
import { fake, real } from './helpers.js'
import type { Lookup } from '../src/ip-policy.js'

const network = vi.hoisted(() => ({
  proxied: false,
  fetch: vi.fn(),
  agents: [] as Array<{ options: { connect: { lookup: Function } }; close: ReturnType<typeof vi.fn> }>,
}))
vi.mock('@deepseek-ai/dsh-http-proxy', () => ({ proxyRouteFor: () => ({ proxied: network.proxied }) }))
vi.mock('undici', () => ({
  Agent: class {
    close = vi.fn(async () => {})
    constructor(public options: { connect: { lookup: Function } }) { network.agents.push(this) }
  },
  fetch: network.fetch,
}))

beforeEach(() => {
  network.proxied = false
  network.agents.length = 0
  network.fetch.mockReset().mockImplementation(async () => new Response('hello', { headers: { 'content-type': 'text/plain' } }))
})
afterEach(() => { vi.restoreAllMocks() })

function setup(config = {}) {
  const lookup = vi.fn<Lookup>(async () => [fake()])
  const validate = vi.fn(async () => ({ addresses: [real()], expiresAt: Date.now() + 60000 }))
  const provider = new FakeIpSafeFetchProvider(config, { lookup, doh: { validate } })
  return { provider, lookup, validate }
}

it('runs the actual upstream provider with pinning, Host/SNI hostname and scoped cleanup', async () => {
  const s = setup()
  const result = await s.provider.fetch({ url: 'https://example.com/path' })
  expect(result).toMatchObject({ url: 'https://example.com/path', statusCode: 200, body: { kind: 'text', content: 'hello' }, truncated: false })
  const [url, options] = network.fetch.mock.calls[0]!
  expect(url.hostname).toBe('example.com')
  expect(options).toMatchObject({ redirect: 'manual', method: 'GET', dispatcher: network.agents[0] })
  const callback = vi.fn()
  network.agents[0]!.options.connect.lookup('example.com', { all: true }, callback)
  expect(callback).toHaveBeenCalledWith(null, [fake()])
  expect(network.agents[0]!.close).toHaveBeenCalledTimes(1)
  expect(s.lookup).toHaveBeenCalledTimes(1)
})

it('fetches through a dual-stack Mihomo fake-IP answer', async () => {
  const s = setup()
  const entries = [fake('198.18.1.47'), { address: 'fdfe:dcba:9876::12c', family: 6 as const }]
  s.lookup.mockResolvedValue(entries)
  expect(await s.provider.fetch({ url: 'https://example.com/' })).toMatchObject({ statusCode: 200, body: { content: 'hello' } })
  expect(s.validate).toHaveBeenCalledTimes(1)
  const callback = vi.fn()
  network.agents[0]!.options.connect.lookup('example.com', { all: true }, callback)
  expect(callback).toHaveBeenCalledWith(null, entries)
})

it('re-resolves and pins the current fake-IP on every same-origin redirect', async () => {
  const s = setup()
  s.lookup.mockResolvedValueOnce([fake()]).mockResolvedValueOnce([fake('198.19.0.2')])
  network.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
  expect((await s.provider.fetch({ url: 'https://example.com/' })).url).toBe('https://example.com/next')
  expect(s.lookup).toHaveBeenCalledTimes(2)
  expect(s.validate).toHaveBeenCalledTimes(1)
  const callback = vi.fn()
  network.agents[1]!.options.connect.lookup('example.com', {}, callback)
  expect(callback).toHaveBeenCalledWith(null, '198.19.0.2', 4)
})

it('blocks a DNS change to private during redirection', async () => {
  const s = setup()
  s.lookup.mockResolvedValueOnce([fake()]).mockResolvedValueOnce([fake('127.0.0.1')])
  network.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
  await expect(s.provider.fetch({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  expect(network.fetch).toHaveBeenCalledTimes(1)
})

it.each(['https://different.example.com/', 'http://example.com/', 'https://example.com:444/'])('blocks cross-origin redirect %s', async location => {
  network.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }))
  await expect(setup().provider.fetch({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'WEB_REDIRECT_BLOCKED' })
  expect(network.fetch).toHaveBeenCalledTimes(1)
})

it('enforces maxRedirects', async () => {
  network.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
  await expect(setup({ maxRedirects: 0 }).provider.fetch({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'WEB_REDIRECT_BLOCKED' })
})

it.each([
  ['file:///etc/passwd', 'WEB_INVALID_URL'], ['bad-url', 'WEB_INVALID_URL'], ['https://u:p@example.com', 'WEB_BLOCKED_URL'],
  ['https://example.com/' + 'x'.repeat(2048), 'WEB_INVALID_URL'], ['http://2130706433/', 'WEB_BLOCKED_URL'], ['http://[::ffff:127.0.0.1]/', 'WEB_BLOCKED_URL'],
])('preserves URL checks for %s', async (url, code) => {
  await expect(setup().provider.fetch({ url })).rejects.toMatchObject({ code })
  expect(network.fetch).not.toHaveBeenCalled()
})

it('refuses an explicit proxy before DNS or transport', async () => {
  network.proxied = true
  const s = setup()
  await expect(s.provider.fetch({ url: 'https://example.com/' })).rejects.toThrow('TUN only')
  expect(s.lookup).not.toHaveBeenCalled()
  expect(network.fetch).not.toHaveBeenCalled()
})

it('keeps byte/character limits, binary rejection, and non-2xx results', async () => {
  const s = setup({ maxResponseBytes: 5, maxBodyChars: 3 })
  network.fetch.mockResolvedValueOnce(new Response('hello!', { status: 404, headers: { 'content-type': 'text/plain' } }))
  expect(await s.provider.fetch({ url: 'https://example.com/' })).toMatchObject({ statusCode: 404, body: { content: 'hel' }, truncated: true })
  network.fetch.mockResolvedValueOnce(new Response('longer', { headers: { 'content-type': 'text/plain', 'content-length': '6' } }))
  await expect(s.provider.fetch({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'WEB_FETCH_TOO_LARGE' })
  network.fetch.mockResolvedValueOnce(new Response('binary', { headers: { 'content-type': 'image/png' } }))
  await expect(s.provider.fetch({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' })
})

it('translates total timeout during DNS to WEB_FETCH_TIMEOUT', async () => {
  const s = setup({ timeoutMs: 15 })
  s.lookup.mockImplementation(() => new Promise(() => {}))
  await expect(s.provider.fetch({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'WEB_FETCH_TIMEOUT' })
})

it('cancels DNS with the caller signal and on dispose', async () => {
  const s = setup()
  s.lookup.mockImplementation(() => new Promise(() => {}))
  const controller = new AbortController()
  const pending = s.provider.fetch({ url: 'https://example.com/' }, controller.signal)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  const pending2 = s.provider.fetch({ url: 'https://example.com/' })
  s.provider.dispose()
  await expect(pending2).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  expect(s.provider.available()).toBe(false)
})
