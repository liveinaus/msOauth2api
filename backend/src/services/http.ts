/**
 * Outbound HTTP with a deadline.
 *
 * Node's fetch has no timeout of its own, so a Microsoft endpoint that accepts the socket
 * and then goes quiet leaves the request hanging until something else gives up. On the mail
 * path that is a poll that never returns and a caller left guessing, so every call made from
 * here gets an explicit budget and a readable error when it runs out.
 */

/** Reads a positive number from the environment, falling back when unset or nonsense. */
export function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Applies to the Graph and token-endpoint calls; override for a slow or proxied network. */
export const httpTimeoutMs = (): number => envMs("MAIL_HTTP_TIMEOUT_MS", 30_000);

export class HttpTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not respond within ${Math.round(ms / 1000)}s`);
    this.name = "HttpTimeoutError";
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  label: string,
  ms = httpTimeoutMs(),
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (error) {
    // AbortSignal.timeout aborts with a TimeoutError; anything else is a real network fault.
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new HttpTimeoutError(label, ms);
    }
    throw error;
  }
}
