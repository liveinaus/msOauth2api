import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Holds captcha answers in the process and hands the client only an opaque id.
 *
 * The answer must never travel to whoever asked for the challenge. Signing it into a token
 * for the browser to quote back looks tempting and is useless: a JWT payload is base64, not
 * ciphertext, so the answer would be one `atob` away and the captcha would stop nobody.
 *
 * A challenge is also good for exactly one attempt. Left replayable, one solved challenge
 * would cover every guess made inside its lifetime, leaving the per-IP limiter as the only
 * real brake on password guessing.
 */

type Challenge = { answer: string; expiresAt: number };

const TTL_MS = 5 * 60_000;

/** Bounds the map when challenges are requested and never used; oldest go first. */
const MAX_CHALLENGES = 500;

const challenges = new Map<string, Challenge>();

function sweep(): void {
  const now = Date.now();
  for (const [id, challenge] of challenges) {
    if (challenge.expiresAt <= now) challenges.delete(id);
  }
  // Map iterates in insertion order, so the first key is always the oldest.
  while (challenges.size >= MAX_CHALLENGES) {
    const oldest = challenges.keys().next();
    if (oldest.done) break;
    challenges.delete(oldest.value);
  }
}

/** Stores an answer and returns the opaque id the client quotes back. */
export function issueCaptcha(answer: string): string {
  sweep();
  const id = randomBytes(24).toString("base64url");
  challenges.set(id, { answer: answer.toLowerCase(), expiresAt: Date.now() + TTL_MS });
  return id;
}

/**
 * Checks an answer and burns the challenge, whether or not it matched. Returns false for an
 * unknown, expired or already-used id, so a caller cannot tell those apart from a wrong
 * answer.
 */
export function consumeCaptcha(id: string | undefined, answer: string | undefined): boolean {
  if (!id || answer == null) return false;

  const challenge = challenges.get(id);
  challenges.delete(id);
  if (!challenge || challenge.expiresAt <= Date.now()) return false;

  const expected = Buffer.from(challenge.answer);
  const given = Buffer.from(answer.toLowerCase().trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Test hook: drops every outstanding challenge. */
export function resetCaptchas(): void {
  challenges.clear();
}

/** Test hook: how many challenges are outstanding. */
export function captchaCount(): number {
  return challenges.size;
}
