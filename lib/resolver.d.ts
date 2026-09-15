import type { HttpFetchResolver } from '@deepseek-ai/dsh-web-fetch-http';
import type { ResolvedConfig } from './config.js';
import { type ValidationResult } from './doh.js';
import { type Lookup } from './ip-policy.js';
export interface Validator {
    validate(host: string, signal: AbortSignal): Promise<ValidationResult>;
}
export interface ResolverDependencies {
    lookup?: Lookup;
    doh?: Validator;
    now?: () => number;
    log?: (message: string) => void;
}
/** Each plugin instance owns a bounded success-only LRU. OS DNS is never cached here. */
export declare class SafeResolver {
    private readonly config;
    private readonly dependencies;
    private readonly lookup;
    private readonly doh;
    private readonly now;
    private readonly cidrs;
    private readonly cache;
    private readonly lifecycle;
    constructor(config: ResolvedConfig, dependencies?: ResolverDependencies);
    dispose(): void;
    readonly resolve: HttpFetchResolver;
    private log;
}
