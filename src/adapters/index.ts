import { mapPool } from "../pool.js";
import type { CompanyRef, FetchResult, Role } from "../types.js";
import { fetchGreenhouse } from "./greenhouse.js";
import { fetchLever } from "./lever.js";
import { fetchAshby } from "./ashby.js";
import { fetchApple } from "./apple.js";

export const DEFAULT_CONCURRENCY = 16;
export const FAILED_SAMPLE_SIZE = 5;

function concurrency(): number {
  const n = Number(process.env.FETCH_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CONCURRENCY;
}

async function fetchCompany(company: CompanyRef, keywords: string[]): Promise<Role[]> {
  switch (company.provider) {
    case "greenhouse":
      return fetchGreenhouse(company);
    case "lever":
      return fetchLever(company);
    case "ashby":
      return fetchAshby(company);
    case "apple":
      return fetchApple(company, keywords);
  }
}

export type RoleFetcher = (companies: CompanyRef[], keywords: string[]) => Promise<FetchResult>;

/**
 * Fetch every board through a bounded concurrency pool (FETCH_CONCURRENCY,
 * default 16; per-request timeout REQUEST_TIMEOUT_MS, default 8000ms). One
 * failing or slow board never fails the check: failures are counted and a
 * small sample of names is kept for reporting, the rest of the boards
 * continue. `keywords` only affects search-driven adapters (Apple).
 */
export const fetchAllRoles: RoleFetcher = async (companies, keywords) => {
  const settled = await mapPool(companies, concurrency(), (c) => fetchCompany(c, keywords));
  const roles: Role[] = [];
  const failed: string[] = [];
  settled.forEach((result, i) => {
    const company = companies[i]!;
    if (result.status === "fulfilled") {
      roles.push(...result.value);
    } else {
      failed.push(company.name);
    }
  });
  if (failed.length > 0) {
    const sample = failed.slice(0, FAILED_SAMPLE_SIZE).join(", ");
    console.error(
      `[job-radar] ${failed.length}/${companies.length} board(s) failed (e.g. ${sample})`,
    );
  }
  return {
    roles,
    failed_count: failed.length,
    failed_sample: failed.slice(0, FAILED_SAMPLE_SIZE),
  };
};
