import { type WebFetchProvider, type WebFetchRequest, type WebFetchResult } from '@deepseek-ai/dsh-web';
import { type Config } from './config.js';
import { type ResolverDependencies } from './resolver.js';
export declare const FETCH_PROVIDER_ID = "fakeip-safe";
export declare class FakeIpSafeFetchProvider implements WebFetchProvider {
    readonly id = "fakeip-safe";
    private readonly delegate;
    private readonly resolver;
    private readonly lifecycle;
    constructor(config?: Config, dependencies?: ResolverDependencies);
    available(): boolean;
    dispose(): void;
    fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>;
}
