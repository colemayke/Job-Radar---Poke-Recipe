import { describe, expect, it } from "vitest";
import { dedupeRoles, matchesFilters, sortNewestFirst, withinWindow } from "../src/matching.js";
import type { Role, WatchConfig } from "../src/types.js";

const role = (over: Partial<Role>): Role => ({
  id: "greenhouse:acme:1",
  company: "Acme",
  title: "Software Engineer",
  location: "New York City, NY",
  remote: false,
  department: "Engineering",
  url: "https://x.example/1",
  posted_at: null,
  source: "greenhouse",
  ...over,
});

const config = (over: Partial<WatchConfig>): WatchConfig => ({
  scope: "registry",
  companies: [],
  keywords: [],
  locations: [],
  remote_only: false,
  posted_within_days: 21,
  ...over,
});

describe("matchesFilters", () => {
  it("applies NO keyword filter when keywords are empty: every function passes", () => {
    const all = config({});
    expect(matchesFilters(role({ title: "Software Engineer" }), all)).toBe(true);
    expect(matchesFilters(role({ title: "Marketing Manager", department: "Marketing" }), all)).toBe(true);
    expect(matchesFilters(role({ title: "Software Development Co-op (Fall 2026)" }), all)).toBe(true);
    expect(matchesFilters(role({ title: "Product Design Intern", department: null }), all)).toBe(true);
    expect(matchesFilters(role({ title: "Account Executive", department: "Sales" }), all)).toBe(true);
  });

  it("narrows to early-career roles with intern/co-op keywords", () => {
    const c = config({ keywords: ["intern", "co-op"] });
    expect(matchesFilters(role({ title: "Product Design Intern" }), c)).toBe(true);
    expect(matchesFilters(role({ title: "Software Development Co-op (Fall 2026)" }), c)).toBe(true);
    expect(matchesFilters(role({ title: "Senior Staff Software Engineer" }), c)).toBe(false);
  });

  it("narrows to a function with a keyword like marketing", () => {
    const c = config({ keywords: ["marketing"] });
    expect(matchesFilters(role({ title: "Growth Marketing Lead", department: null }), c)).toBe(true);
    expect(matchesFilters(role({ title: "Site Reliability Engineer" }), c)).toBe(false);
  });

  it("matches keywords against title and department, case-insensitively", () => {
    const c = config({ keywords: ["FRONTEND"] });
    expect(matchesFilters(role({ title: "Senior Frontend Developer" }), c)).toBe(true);
    expect(matchesFilters(role({ title: "Developer", department: "Frontend Platform" }), c)).toBe(true);
    expect(matchesFilters(role({ title: "Backend Developer", department: "Core" }), c)).toBe(false);
  });

  it("matches locations as substrings", () => {
    const c = config({ locations: ["new york"] });
    expect(matchesFilters(role({}), c)).toBe(true);
    expect(matchesFilters(role({ location: "London, UK" }), c)).toBe(false);
    expect(matchesFilters(role({ location: null }), c)).toBe(false);
  });

  it("lets remote roles pass a 'remote' location filter even with no location", () => {
    const c = config({ locations: ["Remote"] });
    expect(matchesFilters(role({ location: null, remote: true }), c)).toBe(true);
    expect(matchesFilters(role({ location: null, remote: false }), c)).toBe(false);
  });

  it("remote_only keeps flagged-remote roles and 'remote' locations", () => {
    const c = config({ remote_only: true });
    expect(matchesFilters(role({ remote: true }), c)).toBe(true);
    expect(matchesFilters(role({ location: "Remote - USA" }), c)).toBe(true);
    expect(matchesFilters(role({}), c)).toBe(false);
  });
});

describe("dedupeRoles", () => {
  it("collapses the same role listed on two providers, keeping the first", () => {
    const a = role({ id: "ashby:whop:1", source: "ashby" });
    const b = role({ id: "greenhouse:whop:9", source: "greenhouse" });
    const other = role({ id: "ashby:whop:2", title: "Design Engineer" });
    expect(dedupeRoles([a, b, other])).toEqual([a, other]);
  });

  it("treats company/title/location case-insensitively and location null as empty", () => {
    const a = role({ id: "x:1", company: "ACME", title: "ENGINEER", location: null });
    const b = role({ id: "x:2", company: "acme", title: "engineer", location: null });
    expect(dedupeRoles([a, b])).toEqual([a]);
  });
});

describe("withinWindow", () => {
  const now = Date.parse("2026-07-07T00:00:00Z");
  const days = (n: number) => new Date(now - n * 86_400_000).toISOString();

  it("keeps roles inside the window and drops older ones", () => {
    expect(withinWindow(role({ posted_at: days(5) }), 21, now)).toBe(true);
    expect(withinWindow(role({ posted_at: days(22) }), 21, now)).toBe(false);
    expect(withinWindow(role({ posted_at: days(22) }), 30, now)).toBe(true);
  });

  it("treats missing or unparseable dates as posted now", () => {
    expect(withinWindow(role({ posted_at: null }), 1, now)).toBe(true);
    expect(withinWindow(role({ posted_at: "not a date" }), 1, now)).toBe(true);
  });
});

describe("sortNewestFirst", () => {
  it("sorts by posted_at desc with undated roles first", () => {
    const oldRole = role({ id: "x:1", posted_at: "2026-06-01T00:00:00Z" });
    const newRole = role({ id: "x:2", posted_at: "2026-07-01T00:00:00Z" });
    const undated = role({ id: "x:3", posted_at: null });
    expect(sortNewestFirst([oldRole, newRole, undated]).map((r) => r.id)).toEqual([
      "x:3",
      "x:2",
      "x:1",
    ]);
  });
});
