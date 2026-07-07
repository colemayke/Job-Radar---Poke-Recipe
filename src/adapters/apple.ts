import type { CompanyRef, Role } from "../types.js";
import { fetchText } from "./http.js";

/**
 * Apple has no public JSON job API (POST /api/v1/search returns empty for
 * anonymous clients). The search page at jobs.apple.com/en-us/search
 * server-renders results into window.__staticRouterHydrationData, which we
 * parse. Because the board holds thousands of postings, this adapter is
 * search-driven: one newest-sorted query per keyword, deduped. Best-effort by
 * design — verified against the live page on 2026-07-07.
 */

interface AppleResult {
  positionId: string;
  postingTitle: string;
  transformedPostingTitle?: string;
  postingDate?: string;
  homeOffice?: boolean;
  team?: { teamName?: string };
  locations?: Array<{ name?: string }>;
}

const HYDRATION_RE = /window\.__staticRouterHydrationData = JSON\.parse\("((?:[^"\\]|\\.)*)"\)/;

export function parseApplePage(company: CompanyRef, html: string): Role[] {
  const m = HYDRATION_RE.exec(html);
  if (!m) throw new Error("apple: hydration data not found in search page");
  // The capture is the body of a JS double-quoted string literal containing JSON.
  const inner = JSON.parse(`"${m[1]}"`) as string;
  const data = JSON.parse(inner) as {
    loaderData?: { search?: { searchResults?: AppleResult[] } };
  };
  const results = data.loaderData?.search?.searchResults ?? [];
  return results.map((r) => {
    const location = r.locations?.[0]?.name ?? null;
    const slug = r.transformedPostingTitle ?? "";
    const postedMs = r.postingDate ? Date.parse(r.postingDate) : NaN;
    return {
      id: `${company.provider}:${company.token}:${r.positionId}`,
      company: company.name,
      title: r.postingTitle,
      location,
      remote: r.homeOffice === true || /remote/i.test(location ?? ""),
      department: r.team?.teamName ?? null,
      url: `https://jobs.apple.com/en-us/details/${r.positionId}/${slug}`,
      posted_at: Number.isNaN(postedMs) ? null : new Date(postedMs).toISOString(),
      source: "apple",
    };
  });
}

export async function fetchApple(company: CompanyRef, keywords: string[]): Promise<Role[]> {
  const terms = [...new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, 6);
  const byId = new Map<string, Role>();
  const pages = await Promise.allSettled(
    terms.map((t) =>
      fetchText(`https://jobs.apple.com/en-us/search?search=${encodeURIComponent(t)}&sort=newest`),
    ),
  );
  const errors: string[] = [];
  for (const page of pages) {
    if (page.status === "rejected") {
      errors.push(String(page.reason));
      continue;
    }
    try {
      for (const role of parseApplePage(company, page.value)) byId.set(role.id, role);
    } catch (err) {
      errors.push(String(err));
    }
  }
  // Only fail the company if every query failed; partial results are fine.
  if (byId.size === 0 && errors.length > 0) throw new Error(errors[0]);
  return [...byId.values()];
}
