import type { CompanyRef, Role } from "../types.js";
import { fetchJson } from "./http.js";

interface AshbyJob {
  id: string;
  title: string;
  jobUrl: string;
  location?: string | null;
  isRemote?: boolean | null;
  workplaceType?: string | null;
  department?: string | null;
  team?: string | null;
  publishedAt?: string | null;
  isListed?: boolean;
}

export function normalizeAshby(company: CompanyRef, data: unknown): Role[] {
  const jobs = (data as { jobs?: AshbyJob[] }).jobs ?? [];
  return jobs
    .filter((j) => j.isListed !== false)
    .map((j) => {
      const location = j.location ?? null;
      return {
        id: `${company.provider}:${company.token}:${j.id}`,
        company: company.name,
        title: j.title,
        location,
        remote:
          j.isRemote === true ||
          j.workplaceType === "Remote" ||
          /remote/i.test(location ?? ""),
        department: j.department ?? j.team ?? null,
        url: j.jobUrl,
        posted_at: j.publishedAt ?? null,
        source: "ashby",
      };
    });
}

export async function fetchAshby(company: CompanyRef): Promise<Role[]> {
  const data = await fetchJson(
    `https://api.ashbyhq.com/posting-api/job-board/${company.token}`,
  );
  return normalizeAshby(company, data);
}
