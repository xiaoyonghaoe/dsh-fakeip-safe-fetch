import { expect, it, vi } from 'vitest'
import packet, { type Packet } from 'dns-packet'
import { DohClient, type DohTransport } from '../src/doh.js'
import { resolveConfig } from '../src/config.js'
import { a, aaaa, cname, soa, respond, signal } from './helpers.js'

const client = (transport: DohTransport) => new DohClient(resolveConfig(), transport, () => 1000)

it('collects both A and AAAA with the shortest TTL minus HTTP Age', async () => {
  const transport = vi.fn(respond(q => ({ answers: q.type === 'A' ? [a(q.name, undefined, 100)] : [aaaa(q.name, undefined, 60)] }), 10))
  const result = await client(transport).validate('example.com', signal())
  expect(result.addresses).toHaveLength(2)
  expect(result.expiresAt).toBe(51000)
  expect(transport).toHaveBeenCalledTimes(2)
})

it('accepts single stack with a valid negative answer and respects SOA minimum', async () => {
  const result = await client(respond(q => q.type === 'A' ? { answers: [a()] } : { authorities: [soa()] })).validate('example.com', signal())
  expect(result.addresses).toHaveLength(1)
  expect(result.expiresAt).toBe(21000)
})

it('does not cache missing TTL proof or zero TTL', async () => {
  const result = await client(respond(q => q.type === 'A' ? { answers: [a()] } : {})).validate('example.com', signal())
  expect(result.expiresAt).toBe(1000)
  const zero = await client(respond(q => ({ answers: q.type === 'A' ? [a(q.name, undefined, 0)] : [aaaa()] }))).validate('example.com', signal())
  expect(zero.expiresAt).toBe(1000)
})

it('rejects empty combined answers', async () => {
  await expect(client(respond(() => ({}))).validate('example.com', signal())).rejects.toThrow('no A or AAAA')
})

it.each(['10.0.0.1', '169.254.169.254', '198.18.0.1', '127.0.0.1'])('blocks any unsafe answer %s', async address => {
  await expect(client(respond(q => ({ answers: q.type === 'A' ? [a(), a(q.name, address)] : [aaaa()] }))).validate('example.com', signal())).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
})

it('also checks unrelated records and additional glue', async () => {
  await expect(client(respond(q => ({ answers: q.type === 'A' ? [a()] : [aaaa()], additionals: [a('other.example.com', '127.0.0.1')] }))).validate('example.com', signal())).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
})

it('follows same-packet and cross-packet CNAMEs with the alias TTL', async () => {
  const transport = vi.fn(respond(q => {
    if (q.name === 'example.com') return { answers: [cname(q.name, 'alias.example.com', 10)] }
    return { answers: [cname(q.name, 'final.example.com', 5), q.type === 'A' ? a('final.example.com') : aaaa('final.example.com')] }
  }))
  const result = await client(transport).validate('example.com', signal())
  expect(result.addresses).toHaveLength(2)
  expect(result.expiresAt).toBe(6000)
  expect(transport).toHaveBeenCalledTimes(4)
})

it.each(['loop', 'limit', 'incomplete', 'conflict'])('rejects %s CNAME answers', async kind => {
  const transport = respond(q => {
    if (kind === 'loop') return { answers: [cname(q.name, q.name)] }
    if (kind === 'limit') return { answers: [cname(q.name, `a.${q.name}`)] }
    if (kind === 'conflict') return { answers: [cname(q.name, 'alias.example.com'), a(q.name)] }
    return { answers: [a('unrelated.example.com')] }
  })
  await expect(client(transport).validate('example.com', signal())).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
})

it.each([
  { flags: 2 }, { flags: packet.TRUNCATED_RESPONSE }, { id: 999999 }, { type: 'query' },
  { questions: [{ name: 'different.example.com', type: 'A', class: 'IN' }] },
] as Partial<Packet>[])('rejects malformed/mismatched DNS response %j', async change => {
  const transport: DohTransport = async (_url, body) => {
    const query = packet.decode(body)
    const override = 'id' in change ? { id: ((query.id ?? 0) + 1) % 65536 } : change
    return { body: packet.encode({ type: 'response', id: query.id, questions: query.questions, answers: [a()], ...override }), ageSeconds: 0 }
  }
  await expect(client(transport).validate('example.com', signal())).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
})

it('rejects malformed binary messages', async () => {
  await expect(client(async () => ({ body: Buffer.from([0, 1]), ageSeconds: 0 })).validate('example.com', signal())).rejects.toThrow('malformed')
})

it('rejects extended EDNS errors even when the header says NOERROR', async () => {
  await expect(client(respond(q => ({
    answers: q.type === 'A' ? [a()] : [aaaa()],
    additionals: [{ name: '.', type: 'OPT', udpPayloadSize: 4096, extendedRcode: 1, ednsVersion: 0, flags: 0, flag_do: false, options: [] }],
  }))).validate('example.com', signal())).rejects.toThrow('EDNS')
})

it('waits for both families and never accepts partial success', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const transport: DohTransport = async (url, body, abort) => {
    if (packet.decode(body).questions![0]!.type === 'AAAA') { await waiting; throw new Error('AAAA failed') }
    return respond(() => ({ answers: [a()] }))(url, body, abort)
  }
  const completed = vi.fn()
  const promise = client(transport).validate('example.com', signal())
  promise.then(completed, completed)
  await new Promise(resolve => setImmediate(resolve))
  expect(completed).not.toHaveBeenCalled()
  release()
  await expect(promise).rejects.toThrow('AAAA failed')
})

it('times out unresponsive transport and cancels sibling requests', async () => {
  const signals: AbortSignal[] = []
  const transport: DohTransport = (_url, _body, abort) => { signals.push(abort); return new Promise(() => {}) }
  const doh = new DohClient(resolveConfig({ dohTimeoutMs: 15 }), transport)
  await expect(doh.validate('example.com', signal())).rejects.toThrow('timed out')
  expect(signals.every(s => s.aborted)).toBe(true)
})

it('propagates caller cancellation promptly', async () => {
  const controller = new AbortController()
  const pending = client(() => new Promise(() => {})).validate('example.com', controller.signal)
  controller.abort(new Error('user cancelled'))
  await expect(pending).rejects.toThrow('user cancelled')
})
