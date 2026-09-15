import { isIP } from 'node:net'
import type { LookupAddress } from 'node:dns'
import ipaddr from 'ipaddr.js'
import { WebError } from '@deepseek-ai/dsh-web'
import { withSignal } from './abort.js'

export interface Address { readonly address: string; readonly family: 4 | 6 }
export type Lookup = (hostname: string, options: { all: true; order: 'verbatim' }) => Promise<LookupAddress[]>
type Ip = ipaddr.IPv4 | ipaddr.IPv6
export type Cidr = [Ip, number]

export const stripBrackets = (input: string): string => input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input

// Policy follows DSH 0.1.5-rc.2 network.ts (MIT); see THIRD_PARTY_NOTICES.md.
export function isPublicIp(input: string): boolean {
  const text = stripBrackets(input)
  if (!isIP(text) || text.includes('%')) return false
  const parsed = ipaddr.parse(text)
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === 'unicast'
  return parsed.range() === 'unicast'
}

export function parseCidrs(values: readonly string[]): Cidr[] {
  return values.map(value => {
    try {
      const [address, length, extra] = value.split('/')
      if (!address || !length || extra !== undefined || !isIP(address) || !/^\d+$/.test(length) || address.includes('%')) throw new Error()
      return ipaddr.parseCIDR(value)
    } catch { throw new Error(`invalid fake-IP CIDR: ${value}`) }
  })
}

export function isFakeIp(input: string, cidrs: readonly Cidr[]): boolean {
  const parsed = ipaddr.parse(input)
  // Preserve the transport family but classify mapped IPv4 by its underlying IPv4.
  const address: Ip = parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed
  return cidrs.some(([network, prefix]) => address.kind() === network.kind() && address.match(network, prefix))
}

export function validateAddressShape(entries: readonly LookupAddress[]): Address[] {
  if (!entries.length) throw new WebError('hostname resolved to no addresses', 'WEB_PROVIDER_ERROR')
  return entries.map(entry => {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family || entry.address.includes('%')) {
      throw new WebError('hostname resolved to an invalid address', 'WEB_PROVIDER_ERROR')
    }
    return { address: entry.address, family: entry.family }
  })
}

const prefixLengths = [32, 40, 48, 56, 64, 96] as const
type Prefix = { bytes: number[]; length: number }

function embeddedIpv4(bytes: number[], length: number): string | undefined {
  if (length === 96) return bytes.slice(12).join('.')
  if (bytes[8] !== 0) return undefined
  const prefixBytes = length / 8
  return [...bytes.slice(prefixBytes, 8), ...bytes.slice(9, 9 + 4 - (8 - prefixBytes))].join('.')
}

/** RFC 7050 discovery preserves the upstream protection for custom DNS64 prefixes. */
async function nat64Prefixes(lookup: Lookup, signal: AbortSignal): Promise<Prefix[]> {
  const answers = await withSignal(lookup('ipv4only.arpa', { all: true, order: 'verbatim' }), signal)
  const prefixes: Prefix[] = []
  for (const entry of answers) {
    if (entry.family !== 6 || isIP(entry.address) !== 6) continue
    const bytes = ipaddr.parse(entry.address).toByteArray()
    for (const length of prefixLengths) {
      const ipv4 = embeddedIpv4(bytes, length)
      if (ipv4 === '192.0.0.170' || ipv4 === '192.0.0.171') prefixes.push({ bytes: bytes.slice(0, length / 8), length })
    }
  }
  return prefixes
}

export async function assertPublicAddresses(addresses: readonly Address[], lookup: Lookup, signal: AbortSignal): Promise<void> {
  if (!addresses.length || addresses.some(entry => !isPublicIp(entry.address))) {
    throw new WebError('DNS answer contains a non-public destination', 'WEB_BLOCKED_URL')
  }
  if (!addresses.some(entry => entry.family === 6)) return
  const prefixes = await nat64Prefixes(lookup, signal)
  for (const entry of addresses) {
    if (entry.family !== 6) continue
    const bytes = ipaddr.parse(entry.address).toByteArray()
    for (const prefix of prefixes) {
      if (!prefix.bytes.every((byte, index) => bytes[index] === byte)) continue
      const ipv4 = embeddedIpv4(bytes, prefix.length)
      if (ipv4 !== undefined && !isPublicIp(ipv4)) throw new WebError('DNS64 answer translates to a non-public IPv4 address', 'WEB_BLOCKED_URL')
    }
  }
}
