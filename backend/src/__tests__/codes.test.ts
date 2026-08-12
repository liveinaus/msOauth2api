import { describe, expect, it } from "vitest";
import { extractCode } from "../services/codes";

describe("extractCode", () => {
  it("pulls a 6-digit code out of a typical verification email", () => {
    expect(extractCode("Your verification code is 483920. It expires in 10 minutes.", "")).toBe(
      "483920",
    );
  });

  it("reads Chinese verification wording", () => {
    expect(extractCode("您的验证码是 774213，5分钟内有效。", "")).toBe("774213");
  });

  it("falls back to the HTML body when there is no plain text", () => {
    const html = "<p>Security code: <b>907712</b></p><style>.x{width:400px}</style>";
    expect(extractCode("", html)).toBe("907712");
  });

  it("returns undefined when nothing in the mail is code-like", () => {
    expect(extractCode("Your order 12345678 shipped on 2026. Total 4999.", "")).toBeUndefined();
  });

  it("ignores unrelated numbers and picks the one next to the context word", () => {
    const body = "Invoice 2026 for 45990 cents.\nYour one-time passcode is 246810.\nRef 999111";
    expect(extractCode(body, "")).toBe("246810");
  });

  it("prefers a 6-digit run over other lengths near the same wording", () => {
    expect(extractCode("code 1234 ... verification code 556677", "")).toBe("556677");
  });

  it("does not read digits out of CSS or script blocks", () => {
    const html = "<style>.a{margin:123456px}</style><script>var x=654321</script><p>code below</p>";
    expect(extractCode("", html)).toBeUndefined();
  });

  it("uses the subject line as context", () => {
    expect(extractCode("558844", "", "Your login code")).toBe("558844");
  });
});
