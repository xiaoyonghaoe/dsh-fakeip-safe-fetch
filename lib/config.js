import z from '@deepseek-ai/schemastery';
import { isIP } from 'node:net';
import { parseCidrs, isPublicIp, stripBrackets } from './ip-policy.js';
export const defaults = Object.freeze({
    // Mihomo/Clash ship these two fake-IP pools by default: fake-ip-range 198.18.0.1/16
    // and fake-ip-range6 fdfe:dcba:9876::1/64. A proxy answers A and AAAA at once, so a
    // pool that only covers IPv4 rejects every dual-stack answer as a non-public mix.
    fakeIpCidrs: Object.freeze(['198.18.0.0/15', 'fdfe:dcba:9876::/48']),
    dohUrl: 'https://dns.google/dns-query',
    dohTimeoutMs: 5000,
    maxValidationTtlMs: 300000,
    maxResponseBytes: 5000000,
    maxBodyChars: 100000,
    timeoutMs: 30000,
    maxRedirects: 5,
    debug: false,
});
export const Config = z.object({
    fakeIpCidrs: z.array(z.string()).default([...defaults.fakeIpCidrs]),
    dohUrl: z.string().default(defaults.dohUrl),
    dohTimeoutMs: z.number().default(defaults.dohTimeoutMs),
    maxValidationTtlMs: z.number().default(defaults.maxValidationTtlMs),
    maxResponseBytes: z.number().default(defaults.maxResponseBytes),
    maxBodyChars: z.number().default(defaults.maxBodyChars),
    timeoutMs: z.number().default(defaults.timeoutMs),
    maxRedirects: z.number().default(defaults.maxRedirects),
    debug: z.boolean().default(defaults.debug),
});
/** Also fill defaults for programmatic users that do not invoke Schemastery. */
export function resolveConfig(input = {}) {
    const config = { ...defaults, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
    if (!Array.isArray(config.fakeIpCidrs) || config.fakeIpCidrs.some(c => typeof c !== 'string'))
        throw new Error('fakeIpCidrs must be an array of CIDRs');
    parseCidrs(config.fakeIpCidrs);
    let url;
    try {
        url = new URL(config.dohUrl);
    }
    catch {
        throw new Error('dohUrl must be an absolute HTTPS URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
        throw new Error('dohUrl must use HTTPS without credentials or fragment');
    if (isIP(stripBrackets(url.hostname)) && !isPublicIp(url.hostname))
        throw new Error('dohUrl must not name a non-public IP literal');
    for (const key of ['dohTimeoutMs', 'timeoutMs', 'maxResponseBytes', 'maxBodyChars']) {
        if (!Number.isSafeInteger(config[key]) || config[key] <= 0)
            throw new Error(`${key} must be a positive safe integer`);
    }
    for (const key of ['maxValidationTtlMs', 'maxRedirects']) {
        if (!Number.isSafeInteger(config[key]) || config[key] < 0)
            throw new Error(`${key} must be a non-negative safe integer`);
    }
    for (const key of ['dohTimeoutMs', 'timeoutMs']) {
        if (config[key] > 2147483647)
            throw new Error(`${key} exceeds the Node timer range`);
    }
    if (typeof config.debug !== 'boolean')
        throw new Error('debug must be a boolean');
    return Object.freeze({ ...config, fakeIpCidrs: Object.freeze([...config.fakeIpCidrs]), dohUrl: url.href });
}
//# sourceMappingURL=config.js.map