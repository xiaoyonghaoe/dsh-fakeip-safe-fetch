import packet, { type Answer, type Packet, type Question } from 'dns-packet'
import type { DohTransport } from '../src/doh.js'

export const a = (name = 'example.com', data = '93.184.215.14', ttl = 60): Answer => ({ type: 'A', name, data, ttl, class: 'IN' })
export const aaaa = (name = 'example.com', data = '2606:4700:4700::1111', ttl = 60): Answer => ({ type: 'AAAA', name, data, ttl, class: 'IN' })
export const cname = (name: string, data: string, ttl = 30): Answer => ({ type: 'CNAME', name, data, ttl, class: 'IN' })
export const soa = (name = 'example.com', ttl = 30, minimum = 20): Answer => ({ type: 'SOA', name, ttl, class: 'IN', data: { mname: 'ns.example.com', rname: 'hostmaster.example.com', serial: 1, refresh: 60, retry: 30, expire: 600, minimum } })
export const respond = (fn: (question: Question) => Partial<Packet>, ageSeconds = 0): DohTransport => async (_url, body) => {
  const query = packet.decode(body)
  return { body: packet.encode({ type: 'response', id: query.id, flags: packet.RECURSION_AVAILABLE, questions: query.questions, ...fn(query.questions![0]!) }), ageSeconds }
}
export const signal = (): AbortSignal => new AbortController().signal
export const fake = (address = '198.18.0.1') => ({ address, family: 4 as const })
export const real = () => ({ address: '93.184.215.14', family: 4 as const })
