import z from '@deepseek-ai/schemastery';
export interface Config {
    fakeIpCidrs?: string[];
    dohUrl?: string;
    dohTimeoutMs?: number;
    maxValidationTtlMs?: number;
    maxResponseBytes?: number;
    maxBodyChars?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    debug?: boolean;
}
export type ResolvedConfig = Readonly<Omit<Required<Config>, 'fakeIpCidrs'>> & {
    readonly fakeIpCidrs: readonly string[];
};
export declare const defaults: ResolvedConfig;
export declare const Config: z<Config>;
/** Also fill defaults for programmatic users that do not invoke Schemastery. */
export declare function resolveConfig(input?: Config): ResolvedConfig;
