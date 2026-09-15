import { request as httpsRequest } from 'node:https';
import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import packet from 'dns-packet';
import { WebError } from '@deepseek-ai/dsh-web';
import { isPublicIp } from './ip-policy.js';
import { withSignal } from './abort.js';
const MAX_DNS_BYTES = 65535;
const MAX_CNAME_HOPS = 8;
const fail = (message) => new WebError(`DoH: ${message}`, 'WEB_PROVIDER_ERROR');
export function canonicalName(input) {
    const name = input.toLowerCase().replace(/\.$/, '');
    if (!name || name.length > 253 || name.split('.').some(label => !label || label.length > 63 || !/^[a-z0-9_-]+$/.test(label)))
        throw fail('invalid DNS name');
    return name;
}
/** The operator-configured HTTPS endpoint is the trust anchor, not the target's OS DNS answer. */
export const requestDoh = (url, body, signal) => new Promise((resolve, reject) => {
    // agent:false also avoids ambient/global undici dispatchers and shared socket state.
    const request = httpsRequest(url, {
        method: 'POST', agent: false, signal, rejectUnauthorized: true,
        headers: { accept: 'application/dns-message', 'content-type': 'application/dns-message', 'content-length': body.length },
    }, response => {
        response.on('error', reject);
        if (response.statusCode !== 200 || response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/dns-message') {
            reject(fail('expected HTTP 200 application/dns-message'));
            response.destroy();
            return;
        }
        const length = Number(response.headers['content-length']);
        if (length > MAX_DNS_BYTES) {
            reject(fail('response too large'));
            response.destroy();
            return;
        }
        const age = response.headers.age === undefined ? 0 : Number(response.headers.age);
        if (!Number.isSafeInteger(age) || age < 0) {
            reject(fail('invalid HTTP Age'));
            response.destroy();
            return;
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_DNS_BYTES) {
                reject(fail('response too large'));
                response.destroy();
                return;
            }
            chunks.push(chunk);
        });
        response.on('end', () => resolve({ body: Buffer.concat(chunks), ageSeconds: age }));
    });
    request.on('error', reject);
    request.end(body);
});
/** RFC 8484 binary A and AAAA queries, with bounded alias traversal and complete-set validation. */
export class DohClient {
    config;
    transport;
    now;
    constructor(config, transport = requestDoh, now = Date.now) {
        this.config = config;
        this.transport = transport;
        this.now = now;
    }
    async validate(hostname, signal) {
        const controller = new AbortController();
        const combined = AbortSignal.any([signal, controller.signal]);
        try {
            const results = await Promise.all([
                this.resolveType(canonicalName(hostname), 'A', combined),
                this.resolveType(canonicalName(hostname), 'AAAA', combined),
            ]);
            signal.throwIfAborted();
            const addresses = results.flatMap(result => result.addresses);
            if (results.every(result => result.terminalCount === 0))
                throw fail('no A or AAAA addresses');
            return { addresses, expiresAt: Math.min(...results.map(result => result.expiresAt)) };
        }
        finally {
            // Cancel the sibling query when one fails. Neither partial success nor failure is cached.
            controller.abort();
        }
    }
    async query(name, type, signal) {
        signal.throwIfAborted();
        const id = randomInt(65536);
        const body = packet.encode({ type: 'query', id, flags: packet.RECURSION_DESIRED, questions: [{ name, type, class: 'IN' }] });
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(fail('query timed out')), this.config.dohTimeoutMs);
        const combined = AbortSignal.any([signal, timeout.signal]);
        try {
            const response = await withSignal(this.transport(new URL(this.config.dohUrl), body, combined), combined);
            combined.throwIfAborted();
            if (!response.body.length || response.body.length > MAX_DNS_BYTES || !Number.isSafeInteger(response.ageSeconds) || response.ageSeconds < 0)
                throw fail('invalid response size or age');
            let message;
            try {
                message = packet.decode(response.body);
                if (packet.decode.bytes !== response.body.length)
                    throw new Error('trailing bytes');
            }
            catch {
                throw fail('malformed DNS message');
            }
            const question = message.questions?.[0];
            if (message.type !== 'response' || message.id !== id || ((message.flags ?? 0) & 0x780f) !== 0 || message.flag_tc || message.questions?.length !== 1 || !question || question.type !== type || question.class !== 'IN' || canonicalName(question.name) !== name) {
                throw fail('failed, truncated, or mismatched DNS response');
            }
            if (message.additionals?.some(answer => answer.type === 'OPT' && (answer.extendedRcode !== 0 || answer.ednsVersion !== 0)))
                throw fail('unsupported or failed EDNS response');
            return { message, receivedAt: this.now(), age: response.ageSeconds };
        }
        finally {
            clearTimeout(timer);
        }
    }
    async resolveType(start, type, signal) {
        let name = start;
        let hops = 0;
        let expiresAt = Infinity;
        const seen = new Set([name]);
        const observed = [];
        for (;;) {
            const { message, receivedAt, age } = await this.query(name, type, signal);
            const ttlExpiry = (ttl) => receivedAt + Math.max(0, Number.isInteger(ttl) && ttl >= 0 ? ttl - age : 0) * 1000;
            // Reject any non-public address in the complete response, even unrelated/glue records.
            for (const answer of [...(message.answers ?? []), ...(message.additionals ?? []), ...(message.authorities ?? [])]) {
                if (answer.type !== 'A' && answer.type !== 'AAAA')
                    continue;
                const family = answer.type === 'A' ? 4 : 6;
                if (isIP(answer.data) !== family)
                    throw fail('invalid address record');
                if (!isPublicIp(answer.data))
                    throw new WebError('DoH returned a non-public destination', 'WEB_BLOCKED_URL');
                observed.push({ address: answer.data, family });
                expiresAt = Math.min(expiresAt, ttlExpiry(answer.ttl));
            }
            let followed = false;
            for (;;) {
                const records = (message.answers ?? []).filter(answer => canonicalName(answer.name) === name);
                if (records.some(answer => !('class' in answer) || answer.class !== 'IN'))
                    throw fail('unsupported DNS class');
                const addresses = records.filter(answer => answer.type === type);
                const aliases = records.filter((answer) => answer.type === 'CNAME');
                if (aliases.length > 1 || (aliases.length && records.some(answer => answer.type === 'A' || answer.type === 'AAAA')))
                    throw fail('conflicting alias records');
                if (addresses.length)
                    return { addresses: observed, terminalCount: addresses.length, expiresAt };
                if (aliases.length) {
                    const alias = aliases[0];
                    expiresAt = Math.min(expiresAt, ttlExpiry(alias.ttl));
                    name = canonicalName(alias.data);
                    if (++hops > MAX_CNAME_HOPS || seen.has(name))
                        throw fail('CNAME loop or hop limit exceeded');
                    seen.add(name);
                    followed = true;
                    continue;
                }
                const soa = (message.authorities ?? []).filter(answer => answer.type === 'SOA' && answer.class === 'IN' && (name === canonicalName(answer.name) || name.endsWith(`.${canonicalName(answer.name)}`)));
                if (soa.length) {
                    for (const answer of soa) {
                        if (answer.type === 'SOA')
                            expiresAt = Math.min(expiresAt, ttlExpiry(Math.min(answer.ttl ?? 0, answer.data.minimum ?? 0)));
                    }
                    return { addresses: observed, terminalCount: 0, expiresAt };
                }
                if (followed)
                    break; // The recursive server omitted the terminal data: query the alias explicitly.
                if (message.answers?.length)
                    throw fail('incomplete or unrelated DNS answer');
                // NOERROR/NODATA without an SOA can be used for this request only.
                return { addresses: observed, terminalCount: 0, expiresAt: Math.min(expiresAt, receivedAt) };
            }
        }
    }
}
//# sourceMappingURL=doh.js.map