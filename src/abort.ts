/** Stop waiting for non-cancellable OS DNS immediately, without leaking listeners. */
export function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('aborted')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    // Always observe the promise, including an already-aborted call.
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
