import { describe, it, expect } from "vitest";
import {
  searchClaims,
  parseClaimsSearchBody,
  CLAIMS_SEARCH_ENDPOINT,
} from "./factcheck-client.js";

describe("parseClaimsSearchBody — valid payloads", () => {
  const validBody = {
    claims: [
      {
        text: "The moon landing was faked.",
        claimant: "Conspiracy theorists",
        claimDate: "2020-05-01",
        claimReview: [
          {
            publisher: { name: "Snopes", site: "snopes.com" },
            url: "https://snopes.com/fact-check/apollo-faked/",
            title: "Did NASA Fake the Moon Landing?",
            reviewDate: "2021-07-20T00:00:00Z",
            textualRating: "False",
            languageCode: "en",
          },
        ],
      },
    ],
    nextPageToken: "abc123",
  };

  it("parses a valid API response into normalized claims", () => {
    const result = parseClaimsSearchBody(validBody);
    expect(result.claims).toHaveLength(1);
    const c = result.claims[0]!;
    expect(c.claimText).toBe("The moon landing was faked.");
    expect(c.publisher).toBe("Snopes");
    expect(c.publisherSite).toBe("snopes.com");
    expect(c.reviewUrl).toBe("https://snopes.com/fact-check/apollo-faked/");
    expect(c.textualRating).toBe("False");
    expect(c.reviewDate).toBe("2021-07-20T00:00:00Z");
  });

  it("flattens multiple reviews per claim", () => {
    const multiReviewBody = {
      claims: [
        {
          text: "Vaccines cause autism",
          claimReview: [
            {
              publisher: { name: "Snopes" },
              url: "https://snopes.com/1",
              textualRating: "False",
            },
            {
              publisher: { name: "PolitiFact" },
              url: "https://politifact.com/2",
              textualRating: "Pants on Fire",
            },
          ],
        },
      ],
    };
    const result = parseClaimsSearchBody(multiReviewBody);
    expect(result.claims).toHaveLength(2);
    expect(result.claims[0]!.publisher).toBe("Snopes");
    expect(result.claims[1]!.publisher).toBe("PolitiFact");
  });

  it("keeps reviews that have a textualRating but no url", () => {
    const body = {
      claims: [
        {
          text: "Test claim",
          claimReview: [
            { publisher: { name: "P" }, url: "", textualRating: "False" },
          ],
        },
      ],
    };
    const result = parseClaimsSearchBody(body);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.textualRating).toBe("False");
  });

  it("handles non-array claimReview field gracefully", () => {
    const body = {
      claims: [
        {
          text: "Test claim",
          claimReview: {
            publisher: { name: "P" },
            url: "https://p.com",
            textualRating: "False",
          },
        },
      ],
    };
    const result = parseClaimsSearchBody(body);
    expect(result.claims).toHaveLength(1);
  });
});

describe("parseClaimsSearchBody — malformed payloads", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty object", {}],
    ["array body", []],
    ["string body", "nonsense"],
    ["number body", 42],
    ["claims null", { claims: null }],
    ["claims string", { claims: "oops" }],
    ["claims number", { claims: 7 }],
    ["claims with junk entries", { claims: [1, "str", null, true] }],
  ])("returns empty claims for %s", (_label, body) => {
    expect(() => parseClaimsSearchBody(body)).not.toThrow();
    expect(parseClaimsSearchBody(body).claims).toEqual([]);
  });

  it("skips review entries missing both url and textualRating", () => {
    const body = {
      claims: [
        {
          text: "Test",
          claimReview: [{ publisher: { name: "P", site: "p.com" } }, null],
        },
      ],
    };
    expect(parseClaimsSearchBody(body).claims).toEqual([]);
  });

  it("uses default publisher when publisher object is missing", () => {
    const body = {
      claims: [
        {
          text: "Test",
          claimReview: [{ url: "https://x.com", textualRating: "False" }],
        },
      ],
    };
    const result = parseClaimsSearchBody(body);
    expect(result.claims[0]!.publisher).toBe("(unknown publisher)");
  });

  it("truncates long claim text to ~200 chars with ellipsis", () => {
    const body = {
      claims: [
        {
          text: "x".repeat(300),
          claimReview: [
            {
              publisher: { name: "T" },
              url: "https://t.com",
              textualRating: "True",
            },
          ],
        },
      ],
    };
    const c = parseClaimsSearchBody(body).claims[0]!;
    expect(c.claimText.length).toBe(200);
    expect(c.claimText.endsWith("...")).toBe(true);
  });

  it("defaults claim text when missing", () => {
    const body = {
      claims: [
        {
          claimReview: [
            {
              publisher: { name: "T" },
              url: "https://t.com",
              textualRating: "True",
            },
          ],
        },
      ],
    };
    expect(parseClaimsSearchBody(body).claims[0]!.claimText).toBe(
      "(no claim text)",
    );
  });
});

describe("searchClaims", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("sends query, key, and languageCode params", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse({ claims: [] });
    }) as unknown as typeof fetch;

    await searchClaims("vaccine autism", "KEY123", {
      fetchImpl,
      languageCode: "en",
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!);
    expect(url.origin + url.pathname).toBe(CLAIMS_SEARCH_ENDPOINT);
    expect(url.searchParams.get("query")).toBe("vaccine autism");
    expect(url.searchParams.get("key")).toBe("KEY123");
    expect(url.searchParams.get("languageCode")).toBe("en");
  });

  it("returns empty claims for non-OK responses", async () => {
    const fetchImpl = (async () =>
      new Response("{}", { status: 500 })) as unknown as typeof fetch;
    const result = await searchClaims("q", "k", { fetchImpl });
    expect(result.claims).toEqual([]);
  });

  it("returns empty claims when JSON parsing fails", async () => {
    const badJson = {
      json: () => Promise.reject(new SyntaxError("nope")),
      ok: true,
    } as unknown as Response;
    const fetchImpl = (async () => badJson) as unknown as typeof fetch;
    const result = await searchClaims("q", "k", { fetchImpl });
    expect(result.claims).toEqual([]);
  });

  it("passes the abort signal through to fetch", async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return jsonResponse({ claims: [] });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    await searchClaims("q", "k", { fetchImpl, signal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });
});
