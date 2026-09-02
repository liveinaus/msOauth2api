import { describe, expect, it } from "vitest";
import { findLink, linkFromMessage } from "../services/links";
import type { TypeRules } from "../services/typeRules";

const rules = (query: TypeRules["query"] = {}): TypeRules => ({ type: undefined, query });

const mail = (over: Partial<Record<"send" | "subject" | "text" | "html" | "date", string>> = {}) => ({
  send: over.send ?? "noreply@notify.cloudflare.com",
  subject: over.subject ?? "[Action required] Verify your email address",
  text: over.text ?? "",
  html: over.html ?? "",
  date: over.date ?? new Date().toISOString(),
});

describe("linkFromMessage", () => {
  it("takes the anchor carrying what was asked for, not the logo above it", () => {
    const html =
      '<a href="https://www.cloudflare.com/">logo</a>' +
      '<a href="https://dash.cloudflare.com/email-verification?token=abc123">Verify your email</a>';
    expect(linkFromMessage(mail({ html }), "email-verification")).toBe(
      "https://dash.cloudflare.com/email-verification?token=abc123",
    );
  });

  it("unpicks the entities an href carries", () => {
    const html = '<a href="https://x.test/verify?a=1&amp;b=2">go</a>';
    expect(linkFromMessage(mail({ html }), "verify")).toBe("https://x.test/verify?a=1&b=2");
  });

  it("falls back to a bare URL in the plain-text part", () => {
    const text = "Confirm here: https://x.test/confirm/9f8e7d then sign in";
    expect(linkFromMessage(mail({ text }), "confirm")).toBe("https://x.test/confirm/9f8e7d");
  });

  it("prefers the HTML anchor over the text copy of it", () => {
    const html = '<a href="https://x.test/verify/real">go</a>';
    const text = "https://x.test/verify/tracked";
    expect(linkFromMessage(mail({ html, text }), "verify")).toBe("https://x.test/verify/real");
  });

  it("answers nothing when no link carries the fragment", () => {
    const html = '<a href="https://www.cloudflare.com/">logo</a>';
    expect(linkFromMessage(mail({ html }), "email-verification")).toBeUndefined();
  });

  it("takes the first link when nothing is asked for", () => {
    const html = '<a href="https://a.test/one">a</a><a href="https://b.test/two">b</a>';
    expect(linkFromMessage(mail({ html }))).toBe("https://a.test/one");
  });

  it("leaves a mailto or a cid alone", () => {
    const html = '<a href="mailto:someone@x.test">mail</a><a href="cid:logo">img</a>';
    expect(linkFromMessage(mail({ html }))).toBeUndefined();
  });
});

describe("findLink", () => {
  const verify = mail({
    html: '<a href="https://dash.cloudflare.com/email-verification?token=t1">Verify</a>',
  });

  it("skips a message the sender filter rules out", () => {
    const other = mail({
      send: "news@example.com",
      html: '<a href="https://dash.cloudflare.com/email-verification?token=old">Verify</a>',
    });
    const hit = findLink([other, verify], rules({ from: "cloudflare.com" }), "email-verification");
    expect(hit?.link).toContain("token=t1");
  });

  it("skips a message older than the window", () => {
    const stale = mail({
      date: new Date(Date.now() - 60 * 60_000).toISOString(),
      html: '<a href="https://dash.cloudflare.com/email-verification?token=stale">Verify</a>',
    });
    const hit = findLink([stale], rules({ since: Date.now() - 60_000 }), "email-verification");
    expect(hit).toBeUndefined();
  });

  it("answers nothing for an empty folder", () => {
    expect(findLink([], rules(), "email-verification")).toBeUndefined();
  });
});
