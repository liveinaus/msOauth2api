/**
 * View preferences kept in cookies, so a filter survives a reload.
 *
 * Cookies rather than localStorage because they are what was asked for; the values are
 * small and carry nothing sensitive, which matters because unlike localStorage they ride
 * along on every request to the server.
 */
import { ref, watch, type Ref } from "vue";

const PREFIX = "msapi.";
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
/** A filter is a handful of characters; anything longer is not worth sending on every request. */
const MAX_LENGTH = 200;

function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function writeCookie(name: string, value: string): void {
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie =
    `${name}=${encodeURIComponent(value.slice(0, MAX_LENGTH))}` +
    `; path=/; max-age=${MAX_AGE_SECONDS}; samesite=lax${secure}`;
}

/**
 * A ref that loads from its cookie and writes back on every change.
 *
 * A stored value of the wrong type is discarded rather than used: cookies outlive releases
 * and can be edited by hand, and a string where a number belongs would otherwise reach the
 * component as-is.
 */
export function persistentRef<T>(key: string, fallback: T): Ref<T> {
  const name = PREFIX + key;
  const stored = readCookie(name);
  let initial = fallback;

  if (stored !== undefined) {
    try {
      const parsed = JSON.parse(stored) as unknown;
      if (typeof parsed === typeof fallback) initial = parsed as T;
    } catch {
      // Malformed cookie; the default stands and the next change overwrites it.
    }
  }

  const state = ref(initial) as Ref<T>;
  watch(state, (value) => writeCookie(name, JSON.stringify(value)));
  return state;
}
