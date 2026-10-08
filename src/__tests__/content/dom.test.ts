import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { findVideoHits } from "../../content/dom";

function makeDom(html: string): Document {
  return new JSDOM(html, { url: "https://www.youtube.com/" }).window.document;
}

describe("findVideoHits", () => {
  it("collects and de-duplicates video IDs from watch links", () => {
    const doc = makeDom(`
      <div>
        <a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">First</a>
        <a href="https://www.youtube.com/watch?v=aqz-KE-bpKQ">Second</a>
        <a href="/watch?v=dQw4w9WgXcQ&t=10">Dup of first</a>
      </div>
    `);
    const hits = findVideoHits(doc);
    expect(hits.map((h) => h.videoId)).toEqual(["dQw4w9WgXcQ", "aqz-KE-bpKQ"]);
  });

  it("parses relative watch links", () => {
    const doc = makeDom('<a href="/watch?v=abcdefghijk">rel</a>');
    expect(findVideoHits(doc).map((h) => h.videoId)).toEqual(["abcdefghijk"]);
  });

  it("ignores non-watch links", () => {
    const doc = makeDom(`
      <a href="https://www.youtube.com/channel/UC1234567890">Channel</a>
      <a href="https://www.youtube.com/hashtag/shorts">Hashtag</a>
    `);
    expect(findVideoHits(doc)).toEqual([]);
  });

  it("handles empty documents", () => {
    const doc = makeDom("<html><body></body></html>");
    expect(findVideoHits(doc)).toEqual([]);
  });
});
