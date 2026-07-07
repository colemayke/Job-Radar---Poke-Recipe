import type { CompanyRef, Role } from "../types.js";
import { fetchJson } from "./http.js";

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string } | null;
  departments?: Array<{ name?: string }>;
  offices?: Array<{ name?: string }>;
  first_published?: string | null;
  updated_at?: string | null;
}

export function normalizeGreenhouse(company: CompanyRef, data: unknown): Role[] {
  const jobs = (data as { jobs?: GreenhouseJob[] }).jobs ?? [];
  return jobs.map((j) => {
    const location = j.location?.name ?? null;
    const offices = (j.offices ?? []).map((o) => o.name ?? "").join(" ");
    return {
      id: `${company.provider}:${company.token}:${j.id}`,
      company: company.name,
      title: j.title,
      location,
      remote: /remote/i.test(`${location ?? ""} ${offices}`),
      // departments/offices only appear with ?content=true, which we skip at
      // registry scale (10x the payload) — so this is usually null.
      department: j.departments?.[0]?.name ?? null,
      url: j.absolute_url,
      posted_at: j.first_published ?? null,
      source: "greenhouse",
    };
  });
}

export async function fetchGreenhouse(company: CompanyRef): Promise<Role[]> {
  // Plain /jobs (no content=true): verified live 2026-07-07 to include
  // first_published and company_name at ~1/10th the bytes.
  const data = await fetchJson(
    `https://boards-api.greenhouse.io/v1/boards/${company.token}/jobs`,
  );
  return normalizeGreenhouse(company, data);
}
