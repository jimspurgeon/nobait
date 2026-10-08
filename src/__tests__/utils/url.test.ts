import { describe, expect, it } from "vitest";
import { extractVideoId, isYouTubeHost } from "../../utils/url";

describe("extractVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?t=42&v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("extracts %s → %s", (input, expected) => {
    expect(extractVideoId(input)).toBe(expected);
  });

  it.each([
    ["https://www.youtube.com/"],
    ["https://www.youtube.com/feed/subscriptions"],
    ["https://example.com/watch?v=dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=short"],
    [null],
    [""],
  ])("returns null for %s", (input) => {
    expect(extractVideoId(input as string)).toBeNull();
  });
});

describe("isYouTubeHost", () => {
  it.each([
    ["www.youtube.com"],
    ["youtube.com"],
    ["m.youtube.com"],
    ["music.youtube.com"],
  ])("accepts %s", (host) => {
    expect(isYouTubeHost(host)).toBe(true);
  });

  it.each(["notyoutube.com", "youtube.com.evil.example", "example.com"])(
    "rejects %s",
    (host) => {
      expect(isYouTubeHost(host)).toBe(false);
    },
  );
});
