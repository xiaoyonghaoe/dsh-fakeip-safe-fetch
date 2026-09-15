import type { ResolvedConfig } from './config.js';
import { type Address } from './ip-policy.js';
export interface DohResponse {
    body: Buffer;
    ageSeconds: number;
}
export type DohTransport = (url: URL, body: Buffer, signal: AbortSignal) => Promise<DohResponse>;
export interface ValidationResult {
    addresses: Address[];
    expiresAt: number;
}
export declare function canonicalName(input: string): string;
/** The operator-configured HTTPS endpoint is the trust anchor, not the target's OS DNS answer. */
export declare const requestDoh: DohTransport;
/** RFC 8484 binary A and AAAA queries, with bounded alias traversal and complete-set validation. */
export declare class DohClient {
    private readonly config;
    private readonly transport;
    private readonly now;
    constructor(config: ResolvedConfig, transport?: DohTransport, now?: () => number);
    validate(hostname: string, signal: AbortSignal): Promise<ValidationResult>;
    private query;
    private resolveType;
}
