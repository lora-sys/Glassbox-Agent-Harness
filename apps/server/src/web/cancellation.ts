/** Caller cancellation is not a provider failure or timeout. Never expose caller reasons. */
export function throwIfWebCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation cancelled");
}

/** Interrupt only the active bound browser command and remove its listener on settlement. */
export async function cancellableBrowserCommand<T>(
  signal: AbortSignal | undefined,
  execute: () => Promise<T>,
  cancel: () => Promise<void>,
): Promise<T> {
  throwIfWebCancelled(signal);
  let cancellation: Promise<void> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => {
      cancellation ??= Promise.resolve().then(cancel);
      void cancellation.then(
        () => reject(new Error("Operation cancelled")),
        () => reject(new Error("browser_cancel_uncertain")),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([execute(), interrupted]);
    if (cancellation) await cancellation;
    throwIfWebCancelled(signal);
    return result;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (cancellation)
      await cancellation.catch(() => {
        throw new Error("browser_cancel_uncertain");
      });
  }
}
