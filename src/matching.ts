import type { Role, WatchConfig } from "./types.js";

export const DEFAULT_POSTED_WITHIN_DAYS = 21;

/**
 * Matching rules:
 * - keywords: case-insensitive substring against title and department; an
 *   empty keyword list applies NO keyword filter — every role is a candidate
 *   (function-agnostic by design: narrowing to a role type, seniority, or
 *   "intern"/"co-op" is done by passing keywords; resume-fit lives in Poke)
 * - locations: case-insensitive substring against location (a role with no
 *   location only passes a location filter if it is remote and "remote" is
 *   among the requested locations)
 * - remote_only: keeps roles flagged remote or with "remote" in the location
 */
export function matchesFilters(role: Role, config: WatchConfig): boolean {
  if (config.keywords.length > 0) {
    const haystack = `${role.title} ${role.department ?? ""}`.toLowerCase();
    if (!config.keywords.some((k) => haystack.includes(k.toLowerCase()))) return false;
  }

  const isRemote = role.remote || /remote/i.test(role.location ?? "");

  if (config.locations.length > 0) {
    const loc = (role.location ?? "").toLowerCase();
    const locationHit = config.locations.some((l) => {
      const needle = l.toLowerCase();
      if (loc && loc.includes(needle)) return true;
      return isRemote && needle.includes("remote");
    });
    if (!locationHit) return false;
  }

  if (config.remote_only && !isRemote) return false;
  return true;
}

export function filterRoles(roles: Role[], config: WatchConfig): Role[] {
  return roles.filter((r) => matchesFilters(r, config));
}

/**
 * Cross-source dedup: a company that answers on two providers (e.g. a legacy
 * board that was never taken down) must not double-report a role. First
 * occurrence per company|title|location wins.
 */
export function dedupeRoles(roles: Role[]): Role[] {
  const seen = new Set<string>();
  return roles.filter((r) => {
    const key = `${r.company.toLowerCase()}|${r.title.toLowerCase()}|${(r.location ?? "").toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A role with no posted date is treated as posted now: it can never be
 * excluded by the window, but the seen-set still prevents repeat reporting
 * after it first surfaces.
 */
export function withinWindow(role: Role, days: number, now: number = Date.now()): boolean {
  if (role.posted_at === null) return true;
  const posted = Date.parse(role.posted_at);
  if (Number.isNaN(posted)) return true;
  return now - posted <= days * 24 * 60 * 60 * 1000;
}

/** Newest first; roles without a date are treated as posted now (first). */
export function sortNewestFirst(roles: Role[]): Role[] {
  const ts = (r: Role): number => {
    if (r.posted_at === null) return Infinity;
    const t = Date.parse(r.posted_at);
    return Number.isNaN(t) ? Infinity : t;
  };
  return [...roles].sort((a, b) => ts(b) - ts(a));
}
