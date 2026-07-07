import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CompanyRef } from "./types.js";

export type { CompanyRef, Provider } from "./types.js";

/**
 * The originally verified entries (careers pages inspected live 2026-07-07):
 * - Coinbase / Discord: Greenhouse boards answer with jobs
 * - Whop: careers.whop.com links to jobs.ashbyhq.com/whop (a legacy Greenhouse
 *   board "whop" still responds; the live site is Ashby)
 * - Interaction: interaction.co/careers links to jobs.ashbyhq.com/interaction
 */
export const BASE_COMPANIES: CompanyRef[] = [
  { name: "Whop", provider: "ashby", token: "whop" },
  { name: "Coinbase", provider: "greenhouse", token: "coinbase" },
  { name: "Discord", provider: "greenhouse", token: "discord" },
  { name: "The Interaction Company", provider: "ashby", token: "interaction" },
];

/**
 * Apple has no public GH/Ashby/Lever board, so it lives in code, not in
 * data/companies.json. It is always part of registry-scope scans; in custom
 * scopes it participates only when the user names it.
 */
export const APPLE: CompanyRef = { name: "Apple", provider: "apple", token: "apple" };

const registrySchema = z.array(
  z.object({
    name: z.string().min(1),
    provider: z.enum(["greenhouse", "ashby", "lever"]),
    token: z.string().min(1),
    verified_at: z.string().min(1),
  }),
);

export const REGISTRY_PATH = fileURLToPath(new URL("../data/companies.json", import.meta.url));

export function loadRegistryFile(path: string): CompanyRef[] {
  const parsed = registrySchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return parsed.map(({ name, provider, token }) => ({ name, provider, token }));
}

let cachedRegistry: CompanyRef[] | null = null;

/** Verified boards from data/companies.json (empty, with a warning, if absent). */
export function registryCompanies(): CompanyRef[] {
  if (cachedRegistry) return cachedRegistry;
  if (!existsSync(REGISTRY_PATH)) {
    console.warn(`[job-radar] no registry at ${REGISTRY_PATH}; run scripts/build-registry.ts`);
    cachedRegistry = [];
    return cachedRegistry;
  }
  cachedRegistry = loadRegistryFile(REGISTRY_PATH);
  return cachedRegistry;
}

const refKey = (c: CompanyRef): string => `${c.provider}:${c.token}`;

function dedupeRefs(refs: CompanyRef[]): CompanyRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = refKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The full scan set for a registry-scope watch: base + registry + Apple. */
export function registryScope(): CompanyRef[] {
  return dedupeRefs([...BASE_COMPANIES, ...registryCompanies(), APPLE]);
}

/**
 * Look a user-supplied name up among known boards. Case-insensitive against
 * name and token, tolerating partial names ("interaction" matches
 * "The Interaction Company").
 */
export function findByName(raw: string): CompanyRef | undefined {
  const n = raw.trim().toLowerCase();
  if (!n) return undefined;
  const known = registryScope();
  return (
    known.find((c) => c.name.toLowerCase() === n || c.token === n) ??
    known.find((c) => c.name.toLowerCase().includes(n))
  );
}
