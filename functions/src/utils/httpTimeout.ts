// Bounded fetch for external HTTP calls. Cloud Functions have a hard execution
// deadline; an upstream that hangs (Checkr, Google Meet API, etc.) would
// otherwise tie up the invocation until that deadline — and, for webhook
// handlers, hold the event's ledger claim open. AbortController caps the wait
// so a slow upstream fails fast and the handler can degrade or retry.

const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
