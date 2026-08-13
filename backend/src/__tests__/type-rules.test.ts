import { describe, expect, it } from "vitest";
import { extractWithPattern } from "../services/codes";

function compile(pattern: string): RegExp {
  return new RegExp(pattern, "i");
}

describe("extractWithPattern", () => {
  it("returns capture group 1 when the pattern has one", () => {
    const code = extractWithPattern(compile("code:?\\s*(\\d{5,6})"), "Your code: 483920", "");
    expect(code).toBe("483920");
  });

  it("returns the whole match when the pattern has no group", () => {
    const code = extractWithPattern(compile("[a-f0-9]{24}"), "token c5c3fbee7ef822e225cf9c94", "");
    expect(code).toBe("c5c3fbee7ef822e225cf9c94");
  });

  it("reads the subject before the body, being the least ambiguous place", () => {
    const code = extractWithPattern(
      compile("(\\d{6})"),
      "Ignore 111111 in this sentence",
      "",
      "222222 is your code",
    );
    expect(code).toBe("222222");
  });

  it("falls back to the HTML body when there is no plain text", () => {
    const html = "<p>Code: <b>778899</b></p>";
    expect(extractWithPattern(compile("code:?\\s*(\\d{6})"), "", html)).toBe("778899");
  });

  it("returns undefined when nothing matches", () => {
    expect(extractWithPattern(compile("(\\d{6})"), "no digits here", "")).toBeUndefined();
  });

  it("does not carry state between calls, which a global flag would", () => {
    const pattern = compile("(\\d{6})");
    expect(extractWithPattern(pattern, "first 111111", "")).toBe("111111");
    expect(extractWithPattern(pattern, "second 222222", "")).toBe("222222");
  });

  it("ignores an empty match rather than reporting it as a code", () => {
    expect(extractWithPattern(compile("\\d*"), "no digits", "")).toBeUndefined();
  });
});
