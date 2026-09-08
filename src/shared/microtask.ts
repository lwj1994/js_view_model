/** Schedule library work without requiring queueMicrotask from the host. */
export function scheduleMicrotask(callback: () => void): void {
  if (typeof globalThis.queueMicrotask === 'function') {
    globalThis.queueMicrotask(callback);
    return;
  }

  void Promise.resolve().then(() => {
    try {
      // Ignore return values, just as the native microtask API does.
      callback();
    } catch (error) {
      // Preserve uncaught-exception reporting rather than turning a lifecycle
      // failure into an unhandled Promise rejection. Only reporting is deferred
      // to a timer; the scheduled work still runs in the microtask queue.
      setTimeout(() => {
        throw error;
      }, 0);
    }
  });
}
