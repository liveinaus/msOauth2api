/**
 * Applies a configured type's rules to fetched mail: its sender and subject filters, and
 * its own code pattern where the generic extractor is not enough.
 */
import { compilePattern, getUsageTypeByName, type UsageType } from "../db/usageTypes";
import { extractWithPattern } from "./codes";
import { matchesQuery, type CodeQuery } from "./codeSearch";
import type { MailMessage } from "../types";

export type TypeRules = {
  type: UsageType | undefined;
  query: CodeQuery;
};

/**
 * Builds the search for a type, letting explicit arguments win over the stored configuration
 * so a caller can always override what the panel has saved.
 */
export function rulesFor(typeName: string | undefined, overrides: CodeQuery = {}): TypeRules {
  const type = typeName ? getUsageTypeByName(typeName) : undefined;
  return {
    type,
    query: {
      since: overrides.since,
      from: overrides.from ?? type?.fromFilter ?? undefined,
      subject: overrides.subject ?? type?.subjectFilter ?? undefined,
    },
  };
}

/**
 * The message a type is waiting for, with its code resolved.
 *
 * The type's own pattern is tried first and the generic extraction is the fallback, so a
 * configured expression narrows the result without having to cover every mail the service
 * might send. Messages are expected newest first.
 */
export function findForType<T extends MailMessage>(
  messages: T[],
  rules: TypeRules,
): { message: T; code: string | undefined } | undefined {
  const pattern = compilePattern(rules.type?.codePattern ?? null);

  const matching = messages.filter((message) => matchesQuery(message, rules.query));
  if (!matching.length) return undefined;

  if (pattern) {
    for (const message of matching) {
      const code = extractWithPattern(pattern, message.text, message.html, message.subject);
      if (code) return { message, code };
    }
  }

  const withCode = matching.find((message) => message.code);
  if (withCode) return { message: withCode, code: withCode.code };

  // Nothing carried a code, but the sender and subject matched, so this is still the mail
  // the caller was waiting on -- a signup confirmation with a link rather than a code.
  return { message: matching[0], code: undefined };
}
