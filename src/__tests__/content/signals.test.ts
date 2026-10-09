/**
 * DOM-boundary sanitization tests (gatekeeper security finding):
 * HTML entities must be escaped before extracted DOM text
 * (title/description/channel) crosses into AI backends.
 */

import { describe, it, expect } from "vitest";
import { escapeDomText, sanitizeSignal } from "../../content/signals";

describe("escapeDomText", () => {
  it("escapes all five HTML-sensitive entities", () => {
    expect(escapeDomText(`<a href="x">&'yo'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;yo&#39;&lt;/a&gt;",
    );
  });

  it("strips control characters and collapses whitespace", () => {
    expect(escapeDomText("a\u0000b\u0007c\u007fd\u0001\u0002")).toBe("a b c d");
    expect(escapeDomText("hello    \n\t world")).toBe("hello world");
  });

  it("trims leading and trailing whitespace", () => {
    expect(escapeDomText("  padded  ")).toBe("padded");
  });

  it("leaves plain text untouched", () => {
    expect(escapeDomText("Just a normal video title!")).toBe(
      "Just a normal video title!",
    );
  });

  it("returns empty string for control-only input", () => {
    expect(escapeDomText("\u0000\u001f")).toBe("");
  });
});

describe("sanitizeSignal", () => {
  it("escapes title, description, and channel", () => {
    const out = sanitizeSignal({
      videoId: "abc12345678",
      title: "<script>alert(1)</script>",
      description: 'The "best" & worst <b>day</b>',
      channel: "Bob & <Alice>",
    });
    expect(out.title).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out.description).toBe(
      "The &quot;best&quot; &amp; worst &lt;b&gt;day&lt;/b&gt;",
    );
    expect(out.channel).toBe("Bob &amp; &lt;Alice&gt;");
    expect(out.videoId).toBe("abc12345678");
  });

  it("escapes chapter titles", () => {
    const out = sanitizeSignal({
      videoId: "abc12345678",
      title: "T",
      chapters: [{ startMs: 0, title: "Intro <b>part</b>" }],
    });
    expect(out.chapters?.[0]?.title).toBe("Intro &lt;b&gt;part&lt;/b&gt;");
  });

  it("does not mutate the input object", () => {
    const input = { videoId: "x", title: "<i>raw</i>" };
    sanitizeSignal(input);
    expect(input.title).toBe("<i>raw</i>");
  });

  it("passes optional fields through when absent", () => {
    const out = sanitizeSignal({ videoId: "x", title: "Plain" });
    expect(out).toEqual({ videoId: "x", title: "Plain" });
    expect("description" in out).toBe(false);
  });
});
