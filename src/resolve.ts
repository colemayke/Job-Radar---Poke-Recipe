import { fetchAshby } from "./adapters/ashby.js";
import { fetchGreenhouse } from "./adapters/greenhouse.js";
import { fetchLever } from "./adapters/lever.js";
import type { CompanyRef, Role } from "./types.js";

export type BoardProvider = "greenhouse" | "ashby" | "lever";
export const BOARD_PROVIDERS: BoardProvider[] = ["greenhouse", "ashby", "lever"];

/**
 * Board tokens are almost always the slugified company name, but conventions
 * differ ("moderntreasury" vs "modern-treasury"), so we produce both variants.
 */
export function slugVariants(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (words.length === 0) return [];
  return [...new Set([words.join(""), words.join("-")])];
}

export interface ProbeResult {
  provider: BoardProvider;
  token: string;
  jobCount: number;
  /** Epoch ms of the newest posting, or null if the board carries no dates */
  newestPostedAt: number | null;
}

function newestMs(roles: Role[]): number | null {
  let newest: number | null = null;
  for (const r of roles) {
    if (r.posted_at === null) continue;
    const t = Date.parse(r.posted_at);
    if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

/** Probe one provider/token pair; null when it 404s, errors, or is empty. */
export async function probeBoard(
  provider: BoardProvider,
  token: string,
): Promise<ProbeResult | null> {
  const ref: CompanyRef = { name: token, provider, token };
  try {
    const roles =
      provider === "greenhouse"
        ? await fetchGreenhouse(ref)
        : provider === "ashby"
          ? await fetchAshby(ref)
          : await fetchLever(ref);
    if (roles.length === 0) return null;
    return { provider, token, jobCount: roles.length, newestPostedAt: newestMs(roles) };
  } catch {
    return null;
  }
}

/**
 * Cross-listing rule: when a name answers on more than one provider, keep the
 * board whose most recent posting is newest — a proxy for the actively
 * maintained one (e.g. Whop's live Ashby board vs its legacy Greenhouse
 * board). Undated boards rank below dated ones; job count breaks ties.
 */
export function pickLiveliest(probes: ProbeResult[]): ProbeResult | null {
  if (probes.length === 0) return null;
  return [...probes].sort(
    (a, b) =>
      (b.newestPostedAt ?? -1) - (a.newestPostedAt ?? -1) || b.jobCount - a.jobCount,
  )[0]!;
}

export type CompanyResolver = (name: string) => Promise<CompanyRef | null>;

/**
 * Resolve a plain company name to a live board by probing all three provider
 * APIs with the slug variants. Used for on-the-fly `create_watch` names and
 * by the registry scripts.
 */
export const resolveCompanyLive: CompanyResolver = async (name) => {
  const variants = slugVariants(name);
  const probes = await Promise.all(
    variants.flatMap((token) => BOARD_PROVIDERS.map((p) => probeBoard(p, token))),
  );
  const best = pickLiveliest(probes.filter((p): p is ProbeResult => p !== null));
  if (!best) return null;
  return { name: name.trim(), provider: best.provider, token: best.token };
};
