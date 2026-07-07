import type { CompanyRef, Role } from "../types.js";
import { fetchJson } from "./http.js";

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  workplaceType?: string;
  categories?: { location?: string; team?: string; department?: string };
}

export function normalizeLever(company: CompanyRef, data: unknown): Role[] {
  const postings = (data as LeverPosting[]) ?? [];
  return postings.map((p) => {
    const location = p.categories?.location ?? null;
    return {
      id: `${company.provider}:${company.token}:${p.id}`,
      company: company.name,
      title: p.text,
      location,
      remote: p.workplaceType === "remote" || /remote/i.test(location ?? ""),
      department: p.categories?.team ?? p.categories?.department ?? null,
      url: p.hostedUrl,
      posted_at: p.createdAt ? new Date(p.createdAt).toISOString() : null,
      source: "lever",
    };
  });
}

export async function fetchLever(company: CompanyRef): Promise<Role[]> {
  const data = await fetchJson(`https://api.lever.co/v0/postings/${company.token}?mode=json`);
  return normalizeLever(company, data);
}
