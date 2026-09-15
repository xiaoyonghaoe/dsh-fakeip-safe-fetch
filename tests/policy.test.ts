import { describe, expect, it } from 'vitest'
import { resolveConfig, defaults, Config } from '../src/config.js'
import { assertPublicAddresses, isPublicIp, isFakeIp, parseCidrs, validateAddressShape } from '../src/ip-policy.js'
import { signal } from './helpers.js'

describe('address policy', () => {
  it.each(['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '169.254.169.254', '198.18.0.1', '192.0.2.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '64:ff9b::a00:1', '2002:7f00:1::', '::ffff:127.0.0.1', 'fe80::1%en0', '127.1', 'not-an-ip'])('rejects %s', address => expect(isPublicIp(address)).toBe(false))
  it.each(['8.8.8.8', '93.184.215.14', '2606:4700:4700::1111', '[2606:4700:4700::1111]', '::ffff:8.8.8.8'])('accepts %s', address => expect(isPublicIp(address)).toBe(true))
  it('matches precise IPv4 and IPv6 CIDRs', () => {
    const cidrs = parseCidrs(['198.18.0.0/15', 'fd00:6152::/32'])
    expect(isFakeIp('198.19.255.255', cidrs)).toBe(true)
    expect(isFakeIp('198.20.0.1', cidrs)).toBe(false)
    expect(isFakeIp('::ffff:198.18.0.1', cidrs)).toBe(true)
    expect(isFakeIp('fd00:6152::1', cidrs)).toBe(true)
  })
  it('rejects malformed DNS answers', () => {
    expect(() => validateAddressShape([])).toThrow('no addresses')
    expect(() => validateAddressShape([{ address: '8.8.8.8', family: 6 }])).toThrow('invalid address')
  })
  it('rejects a private IPv4 destination embedded in a custom NAT64 prefix', async () => {
    const lookup = async () => [{ address: '2001:4860:abcd::c000:aa', family: 6 }]
    await expect(assertPublicAddresses([{ address: '2001:4860:abcd::a00:1', family: 6 }], lookup, signal())).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    await expect(assertPublicAddresses([{ address: '2001:4860:abcd::808:808', family: 6 }], lookup, signal())).resolves.toBeUndefined()
  })
})

describe('config', () => {
  it('fills both schema and programmatic defaults', () => {
    expect(resolveConfig()).toEqual(defaults)
    expect(Config({})).toEqual(defaults)
    expect(resolveConfig({ timeoutMs: undefined })).toEqual(defaults)
  })
  it.each([
    { fakeIpCidrs: ['198.18.0.0/33'] }, { fakeIpCidrs: ['0x7f000001/8'] }, { fakeIpCidrs: ['::/129'] },
    { dohUrl: 'http://dns.google/dns-query' }, { dohUrl: 'https://user:pass@dns.google/' }, { dohUrl: 'https://dns.google/#x' }, { dohUrl: 'https://127.0.0.1/' },
    { dohTimeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2147483648 }, { maxBodyChars: 1.5 }, { maxResponseBytes: -1 }, { maxRedirects: -1 }, { maxValidationTtlMs: NaN },
  ])('rejects unsafe/invalid config %j', input => expect(() => resolveConfig(input)).toThrow())
  it('allows disabling caching and redirects', () => {
    expect(resolveConfig({ maxValidationTtlMs: 0, maxRedirects: 0, fakeIpCidrs: [] }).maxValidationTtlMs).toBe(0)
  })
})
