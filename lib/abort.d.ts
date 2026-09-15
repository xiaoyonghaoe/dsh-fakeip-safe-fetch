/** Stop waiting for non-cancellable OS DNS immediately, without leaking listeners. */
export declare function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>;
