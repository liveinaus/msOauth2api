/**
 * Verification-code extraction. Upstream advertised this in its README but never shipped
 * it, and it is the single most common reason to call the mail endpoints at all, so it is
 * here as an additive `code` field.
 */

const DIGIT_PATTERN = /\b(\d{4,8})\b/g;

/**
 * Token-style codes: the hex or mixed strings services hand out for confirmation links and
 * single-use logins, e.g. c5c3fbee7ef822e225cf9c94 or a bare UUID. Hyphens are inside the
 * run so a UUID is captured whole rather than as five fragments.
 */
const TOKEN_PATTERN = /\b([A-Za-z0-9][A-Za-z0-9-]{11,63})\b/g;

/**
 * A token touching one of these is part of a URL or an address -- an unsubscribe link or a
 * tracking pixel, not something to type into a form. Digit runs are left alone, since they
 * are short enough that the context window already carries the decision.
 */
const URL_BEFORE = /[/=?&@.]/;
const URL_AFTER = /[/=?&@]/;

/**
 * Words that sit next to a real code. A mailbox full of marketing HTML has plenty of
 * standalone digit runs -- years, prices, order numbers, tracking ids -- so a bare
 * "first number in the body" rule picks the wrong one more often than not.
 */
const CONTEXT_WORDS =
  /(code|otp|passcode|password|verification|verify|authenticate|security|2fa|one[- ]time|验证码|校验码|动态码|驗證碼)/i;

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
}

/** A token has to mix letters and digits; prose and pure numbers are handled elsewhere. */
function isTokenLike(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

/**
 * Returns the most likely verification code, or undefined when nothing looks like one.
 *
 * Candidates are scored by how close they sit to a context word rather than by position,
 * and a 6-digit run wins ties because that is overwhelmingly the length services use. A
 * token beats the other digit lengths: a mail carrying one is almost always handing over a
 * single-use string, whereas a stray 4- or 8-digit run is as likely to be an order number.
 */
export function extractCode(text: string, html: string, subject = ""): string | undefined {
  const body = (text && text.trim() ? text : stripHtml(html)) || "";
  const haystack = `${subject}\n${body}`;
  if (!CONTEXT_WORDS.test(haystack)) return undefined;

  let best: { value: string; score: number } | undefined;

  const consider = (value: string, at: number, bonus: number): void => {
    // Look a short way either side for a context word; nearer scores higher.
    const window = haystack.slice(Math.max(0, at - 60), at + value.length + 60);
    if (!CONTEXT_WORDS.test(window)) return;

    const score = 100 - Math.min(at, 99) / 100 + bonus;
    if (!best || score > best.score) best = { value, score };
  };

  for (const match of haystack.matchAll(DIGIT_PATTERN)) {
    const value = match[1];
    const bonus = value.length === 6 ? 10 : value.length === 4 || value.length === 8 ? 4 : 0;
    consider(value, match.index ?? 0, bonus);
  }

  for (const match of haystack.matchAll(TOKEN_PATTERN)) {
    const value = match[1];
    const at = match.index ?? 0;
    if (!isTokenLike(value)) continue;
    if (URL_BEFORE.test(haystack[at - 1] ?? "")) continue;
    if (URL_AFTER.test(haystack[at + value.length] ?? "")) continue;
    consider(value, at, 8);
  }

  return best?.value;
}
