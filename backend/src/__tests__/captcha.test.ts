import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captchaCount, consumeCaptcha, issueCaptcha, resetCaptchas } from "../auth/captchaStore";

describe("captchaStore", () => {
  beforeEach(resetCaptchas);
  afterEach(() => vi.useRealTimers());

  it("accepts the right answer", () => {
    const id = issueCaptcha("Ab3Kx");
    expect(consumeCaptcha(id, "Ab3Kx")).toBe(true);
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(consumeCaptcha(issueCaptcha("Ab3Kx"), "ab3kx")).toBe(true);
    expect(consumeCaptcha(issueCaptcha("Ab3Kx"), "  AB3KX  ")).toBe(true);
  });

  it("rejects a wrong answer", () => {
    expect(consumeCaptcha(issueCaptcha("Ab3Kx"), "wrong")).toBe(false);
  });

  it("burns the challenge, so a solved one cannot be replayed", () => {
    const id = issueCaptcha("Ab3Kx");
    expect(consumeCaptcha(id, "Ab3Kx")).toBe(true);
    // This is what stops one solved captcha covering a run of password guesses.
    expect(consumeCaptcha(id, "Ab3Kx")).toBe(false);
  });

  it("burns the challenge even when the answer was wrong", () => {
    const id = issueCaptcha("Ab3Kx");
    expect(consumeCaptcha(id, "nope")).toBe(false);
    expect(consumeCaptcha(id, "Ab3Kx")).toBe(false);
  });

  it("rejects an unknown or missing id", () => {
    expect(consumeCaptcha("no-such-id", "Ab3Kx")).toBe(false);
    expect(consumeCaptcha(undefined, "Ab3Kx")).toBe(false);
    expect(consumeCaptcha(issueCaptcha("Ab3Kx"), undefined)).toBe(false);
  });

  it("expires a challenge after its five-minute life", () => {
    vi.useFakeTimers();
    const id = issueCaptcha("Ab3Kx");
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(consumeCaptcha(id, "Ab3Kx")).toBe(false);
  });

  it("issues ids that are unique and do not contain the answer", () => {
    const answer = "Ab3Kx";
    const ids = new Set(Array.from({ length: 50 }, () => issueCaptcha(answer)));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      // An id that leaked the answer would make the whole challenge pointless.
      expect(id.toLowerCase()).not.toContain(answer.toLowerCase());
      expect(Buffer.from(id, "base64url").toString("utf8")).not.toContain(answer);
    }
  });

  it("bounds the store so unused challenges cannot grow without limit", () => {
    for (let i = 0; i < 700; i++) issueCaptcha(`ans${i}`);
    expect(captchaCount()).toBeLessThanOrEqual(500);
  });

  it("drops the oldest challenge first once the bound is reached", () => {
    const oldest = issueCaptcha("first");
    for (let i = 0; i < 600; i++) issueCaptcha(`ans${i}`);
    expect(consumeCaptcha(oldest, "first")).toBe(false);
  });
});
