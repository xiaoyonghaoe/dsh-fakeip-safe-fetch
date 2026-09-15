import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
export { Config, defaults, resolveConfig } from './config.js';
export type { ResolvedConfig } from './config.js';
export { FakeIpSafeFetchProvider, FETCH_PROVIDER_ID } from './provider.js';
export declare const name = "web-fetch-fakeip-safe";
export declare const inject: string[];
export declare function apply(ctx: Context, config?: Config): void;
