import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeAshby } from "../src/adapters/ashby.js";
import { fetchApple, parseApplePage } from "../src/adapters/apple.js";
import { normalizeGreenhouse } from "../src/adapters/greenhouse.js";
import { normalizeLever } from "../src/adapters/lever.js";
import type { CompanyRef, Role } from "../src/types.js";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");

function expectValidRoles(roles: Role[], company: CompanyRef, source: string) {
  expect(roles.length).toBeGreaterThan(0);
  for (const r of roles) {
    expect(r.id).toMatch(new RegExp(`^${company.provider}:${company.token}:.+`));
    expect(r.company).toBe(company.name);
    expect(r.title).toBeTruthy();
    expect(r.url).toMatch(/^https?:\/\//);
    expect(typeof r.remote).toBe("boolean");
    expect(r.source).toBe(source);
    if (r.posted_at !== null) {
      expect(Number.isNaN(Date.parse(r.posted_at))).toBe(false);
    }
  }
}

describe("greenhouse adapter", () => {
  const company: CompanyRef = { name: "Coinbase", provider: "greenhouse", token: "coinbase" };

  it("normalizes jobs from a real board payload with posted_at", () => {
    const roles = normalizeGreenhouse(company, JSON.parse(fixture("greenhouse.json")));
    expectValidRoles(roles, company, "greenhouse");
    const first = roles[0]!;
    expect(first.location).toBeTypeOf("string");
    // first_published (confirmed live) maps to posted_at
    expect(first.posted_at).toBeTypeOf("string");
  });

  it("flags remote from location or offices", () => {
    const roles = normalizeGreenhouse(company, {
      jobs: [
        {
          id: 1,
          title: "Engineer",
          absolute_url: "https://x.example/1",
          location: { name: "Remote - USA" },
        },
        {
          id: 2,
          title: "Engineer",
          absolute_url: "https://x.example/2",
          location: { name: "NYC" },
          offices: [{ name: "US - Remote Zone 1" }],
        },
        { id: 3, title: "Engineer", absolute_url: "https://x.example/3", location: { name: "NYC" } },
      ],
    });
    expect(roles.map((r) => r.remote)).toEqual([true, true, false]);
  });
});

describe("lever adapter", () => {
  const company: CompanyRef = { name: "Palantir", provider: "lever", token: "palantir" };

  it("normalizes postings from a real board payload with posted_at", () => {
    const roles = normalizeLever(company, JSON.parse(fixture("lever.json")));
    expectValidRoles(roles, company, "lever");
    // createdAt epoch ms (confirmed live) maps to posted_at
    expect(roles[0]!.posted_at).toBeTypeOf("string");
  });

  it("flags remote via workplaceType", () => {
    const roles = normalizeLever(company, [
      {
        id: "a",
        text: "Engineer",
        hostedUrl: "https://x.example/a",
        workplaceType: "remote",
        categories: { location: "USA" },
      },
    ]);
    expect(roles[0]!.remote).toBe(true);
  });
});

describe("ashby adapter", () => {
  const company: CompanyRef = { name: "Whop", provider: "ashby", token: "whop" };

  it("normalizes jobs from a real board payload with posted_at", () => {
    const roles = normalizeAshby(company, JSON.parse(fixture("ashby.json")));
    expectValidRoles(roles, company, "ashby");
    // publishedAt (confirmed live) maps to posted_at
    expect(roles[0]!.posted_at).toBeTypeOf("string");
  });

  it("drops unlisted jobs and flags remote", () => {
    const roles = normalizeAshby(company, {
      jobs: [
        { id: "a", title: "Hidden", jobUrl: "https://x.example/a", isListed: false },
        { id: "b", title: "Engineer", jobUrl: "https://x.example/b", isRemote: true },
      ],
    });
    expect(roles).toHaveLength(1);
    expect(roles[0]!.remote).toBe(true);
  });
});

describe("apple adapter", () => {
  const company: CompanyRef = { name: "Apple", provider: "apple", token: "apple" };

  it("parses roles out of the search page hydration data", () => {
    const roles = parseApplePage(company, fixture("apple.html"));
    expectValidRoles(roles, company, "apple");
    expect(roles[0]!.url).toMatch(/^https:\/\/jobs\.apple\.com\/en-us\/details\//);
  });

  it("throws a clear error when the page shape changes", () => {
    expect(() => parseApplePage(company, "<html><body>nope</body></html>")).toThrow(
      /hydration data/,
    );
  });

  it("with no keywords, fetches the unfiltered newest pages instead of searching", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      requested.push(String(url));
      return new Response(fixture("apple.html"), { status: 200 });
    });
    try {
      const roles = await fetchApple(company, []);
      expect(roles.length).toBeGreaterThan(0);
      expect(requested).toHaveLength(3);
      for (const u of requested) {
        expect(u).toContain("sort=newest");
        expect(u).not.toContain("search=");
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
