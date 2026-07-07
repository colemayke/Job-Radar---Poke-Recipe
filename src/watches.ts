import { nanoid } from "nanoid";
import type { RoleFetcher } from "./adapters/index.js";
import { findByName, registryScope } from "./companies.js";
import type { WatchStore } from "./db.js";
import {
  DEFAULT_KEYWORDS,
  DEFAULT_POSTED_WITHIN_DAYS,
  dedupeRoles,
  filterRoles,
  sortNewestFirst,
  withinWindow,
} from "./matching.js";
import { resolveCompanyLive, type CompanyResolver } from "./resolve.js";
import type { CompanyRef, Role, WatchConfig } from "./types.js";

export interface WatchInput {
  companies?: string[];
  keywords?: string[];
  locations?: string[];
  remote_only?: boolean;
  posted_within_days?: number;
}

export function effectiveKeywords(config: Pick<WatchConfig, "keywords">): string[] {
  return config.keywords.length > 0 ? config.keywords : DEFAULT_KEYWORDS;
}

/** dedupe -> freshness window -> coarse filter: the narrowing pipeline. */
export function narrow(roles: Role[], config: WatchConfig, now: number = Date.now()): Role[] {
  const fresh = dedupeRoles(roles).filter((r) =>
    withinWindow(r, config.posted_within_days, now),
  );
  return filterRoles(fresh, config);
}

export interface Resolution {
  refs: CompanyRef[];
  unresolved: string[];
}

const refKey = (c: CompanyRef): string => `${c.provider}:${c.token}`;

export class WatchService {
  constructor(
    private store: WatchStore,
    private fetchRoles: RoleFetcher,
    private resolver: CompanyResolver = resolveCompanyLive,
  ) {}

  /**
   * Resolve plain company names to boards: registry lookup first, then a live
   * probe of all three providers. Resolved refs are persisted in the watch
   * config so checks never re-resolve; misses come back in `unresolved`.
   */
  async resolveNames(names: string[]): Promise<Resolution> {
    const refs: CompanyRef[] = [];
    const unresolved: string[] = [];
    const seen = new Set<string>();
    for (const raw of names) {
      const name = raw.trim();
      if (!name) continue;
      const ref = findByName(name) ?? (await this.resolver(name));
      if (!ref) {
        unresolved.push(name);
      } else if (!seen.has(refKey(ref))) {
        seen.add(refKey(ref));
        refs.push(ref);
      }
    }
    return { refs, unresolved };
  }

  /** The boards a config scans: the whole registry, or its custom set. */
  scopeCompanies(config: WatchConfig): CompanyRef[] {
    return config.scope === "registry" ? registryScope() : config.companies;
  }

  private async buildConfig(input: WatchInput): Promise<{ config: WatchConfig; unresolved: string[] }> {
    const { refs, unresolved } = await this.resolveNames(input.companies ?? []);
    const custom = (input.companies ?? []).length > 0;
    return {
      config: {
        scope: custom ? "custom" : "registry",
        companies: custom ? refs : [],
        keywords: input.keywords ?? [],
        locations: input.locations ?? [],
        remote_only: input.remote_only ?? false,
        posted_within_days: input.posted_within_days ?? DEFAULT_POSTED_WITHIN_DAYS,
      },
      unresolved,
    };
  }

  /**
   * Persist the watch, then seed the seen-set with every in-window role
   * passing the coarse filter across the scoped set, so the first scheduled
   * check only surfaces postings that appeared after creation.
   */
  async create(input: WatchInput): Promise<
    | {
        watchId: string;
        matchedNow: Role[];
        failedCount: number;
        failedSample: string[];
        unresolved: string[];
        config: WatchConfig;
      }
    | { error: "nothing_resolved"; unresolved: string[] }
  > {
    const { config, unresolved } = await this.buildConfig(input);
    if (config.scope === "custom" && config.companies.length === 0) {
      return { error: "nothing_resolved", unresolved };
    }
    const watchId = nanoid(12);
    await this.store.createWatch(watchId, config);
    const { roles, failed_count, failed_sample } = await this.fetchRoles(
      this.scopeCompanies(config),
      effectiveKeywords(config),
    );
    const matchedNow = sortNewestFirst(narrow(roles, config));
    await this.store.markSeen(watchId, matchedNow.map((r) => r.id));
    return {
      watchId,
      matchedNow,
      failedCount: failed_count,
      failedSample: failed_sample,
      unresolved,
      config,
    };
  }

  /**
   * Fetch the scope, narrow (dedupe -> window -> filter), diff against the
   * seen-set. Ids are inserted with ON CONFLICT DO NOTHING RETURNING, and
   * only roles actually inserted by this call are reported — so concurrent
   * or repeated calls report each role at most once.
   */
  async check(watchId: string): Promise<{
    newRoles: Role[];
    failedCount: number;
    failedSample: string[];
  } | null> {
    const config = await this.store.getWatch(watchId);
    if (!config) return null;
    const { roles, failed_count, failed_sample } = await this.fetchRoles(
      this.scopeCompanies(config),
      effectiveKeywords(config),
    );
    const candidates = narrow(roles, config);
    const inserted = new Set(await this.store.markSeen(watchId, candidates.map((r) => r.id)));
    return {
      newRoles: sortNewestFirst(candidates.filter((r) => inserted.has(r.id))),
      failedCount: failed_count,
      failedSample: failed_sample,
    };
  }

  /**
   * Merge partial changes. Any change that can broaden matches (companies,
   * keywords, or locations changed; remote_only switched off; window grew)
   * re-seeds the seen-set with the new scope's current matches, so the next
   * check still only reports genuinely new postings.
   */
  async update(
    watchId: string,
    input: WatchInput,
  ): Promise<{ config: WatchConfig; unresolved: string[] } | null> {
    const existing = await this.store.getWatch(watchId);
    if (!existing) return null;

    let companies = existing.companies;
    let scope = existing.scope;
    let unresolved: string[] = [];
    if (input.companies !== undefined) {
      if (input.companies.length === 0) {
        scope = "registry";
        companies = [];
      } else {
        const resolution = await this.resolveNames(input.companies);
        unresolved = resolution.unresolved;
        if (resolution.refs.length > 0) {
          scope = "custom";
          companies = resolution.refs;
        }
      }
    }

    const merged: WatchConfig = {
      scope,
      companies,
      keywords: input.keywords ?? existing.keywords,
      locations: input.locations ?? existing.locations,
      remote_only: input.remote_only ?? existing.remote_only,
      posted_within_days: input.posted_within_days ?? existing.posted_within_days,
    };
    await this.store.updateWatch(watchId, merged);

    const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    const broadened =
      (input.companies !== undefined &&
        !sameJson(
          { s: existing.scope, c: existing.companies.map(refKey).sort() },
          { s: merged.scope, c: merged.companies.map(refKey).sort() },
        )) ||
      (input.keywords !== undefined && !sameJson(existing.keywords, merged.keywords)) ||
      (input.locations !== undefined && !sameJson(existing.locations, merged.locations)) ||
      (existing.remote_only && !merged.remote_only) ||
      merged.posted_within_days > existing.posted_within_days;

    if (broadened) {
      const { roles } = await this.fetchRoles(
        this.scopeCompanies(merged),
        effectiveKeywords(merged),
      );
      await this.store.markSeen(watchId, narrow(roles, merged).map((r) => r.id));
    }
    return { config: merged, unresolved };
  }

  async delete(watchId: string): Promise<boolean> {
    return this.store.deleteWatch(watchId);
  }
}
