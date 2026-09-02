/**
 * Confirmation-link extraction, for services that verify an address by having it visited
 * rather than by mailing a code.
 *
 * Separate from code extraction because it reads what code extraction never sees: the URL
 * lives in an anchor's href, and the `code` field a message carries is a digit or token run
 * pulled out of the readable text.
 */
import { matchesQuery } from "./codeSearch";
import type { TypeRules } from "./typeRules";
import type { MailMessage } from "../types";

/** Bounds what the link scan runs over, as the pattern extractor bounds its own input. */
const SCAN_MAX = 200_000;

/** Unpicks the entities an href carries in HTML; a browser would be given none of them. */
function unescapeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/**
 * The first link in a message carrying `contains`, or the first link at all when nothing
 * is asked for.
 *
 * Anchors are read before the plain-text part: a mail that carries both puts the real
 * address in the HTML and often a tracked or line-wrapped copy in the text.
 */
export function linkFromMessage(
  message: Pick<MailMessage, "text" | "html">,
  contains?: string,
): string | undefined {
  const needle = (contains ?? "").trim().toLowerCase();
  const html = String(message.html ?? "").slice(0, SCAN_MAX);
  const text = String(message.text ?? "").slice(0, SCAN_MAX);

  const candidates = [
    ...[...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => unescapeHtml(m[1])),
    ...[...text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].map((m) => m[0]),
  ];

  for (const url of candidates) {
    if (!/^https?:\/\//i.test(url)) continue;
    if (needle && !url.toLowerCase().includes(needle)) continue;
    return url;
  }
  return undefined;
}

/**
 * The newest message matching the type's rules that carries a link, and that link.
 *
 * Messages are expected newest first, as the folder readers return them. The sender and
 * subject filters are the type's, so a configured type narrows this the same way it
 * narrows a code read.
 */
export function findLink<T extends MailMessage>(
  messages: T[],
  rules: TypeRules,
  contains?: string,
): { message: T; link: string } | undefined {
  for (const message of messages) {
    if (!matchesQuery(message, rules.query)) continue;
    const link = linkFromMessage(message, contains);
    if (link) return { message, link };
  }
  return undefined;
}
