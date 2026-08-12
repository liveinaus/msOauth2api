/**
 * Verification-code extraction. Upstream advertised this in its README but never shipped
 * it, and it is the single most common reason to call the mail endpoints at all, so it is
 * here as an additive `code` field.
 */

const CODE_PATTERN = /\b(\d{4,8})\b/g;

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

/**
 * Returns the most likely verification code, or undefined when nothing looks like one.
 *
 * Candidates are scored by how close they sit to a context word rather than by position,
 * and a 6-digit run wins ties because that is overwhelmingly the length services use.
 */
export function extractCode(text: string, html: string, subject = ""): string | undefined {
  const body = (text && text.trim() ? text : stripHtml(html)) || "";
  const haystack = `${subject}\n${body}`;
  if (!CONTEXT_WORDS.test(haystack)) return undefined;

  let best: { value: string; score: number } | undefined;

  for (const match of haystack.matchAll(CODE_PATTERN)) {
    const value = match[1];
    const at = match.index ?? 0;

    // Look a short way either side for a context word; nearer scores higher.
    const window = haystack.slice(Math.max(0, at - 60), at + value.length + 60);
    if (!CONTEXT_WORDS.test(window)) continue;

    let score = 100 - Math.min(at, 99) / 100;
    if (value.length === 6) score += 10;
    else if (value.length === 4 || value.length === 8) score += 4;

    if (!best || score > best.score) best = { value, score };
  }

  return best?.value;
}
