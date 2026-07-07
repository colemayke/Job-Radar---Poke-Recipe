/**
 * Builds data/companies.json by live-verifying the curated candidate list:
 * every (slug variant x provider) pair is probed against the public board
 * APIs, only 200-with-jobs boards are kept, and cross-listed names keep the
 * provider with the newest posting. Never runs in CI.
 *
 *   npm run build-registry
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchJson } from "../src/adapters/http.js";
import { BASE_COMPANIES, APPLE } from "../src/companies.js";
import { mapPool } from "../src/pool.js";
import {
  BOARD_PROVIDERS,
  pickLiveliest,
  probeBoard,
  slugVariants,
  type ProbeResult,
} from "../src/resolve.js";
import { CANDIDATES, type Candidate } from "./candidates.js";

// Verification cares about board existence, not latency: default to a
// generous per-request timeout so huge-but-alive boards (SpaceX, ~2MB) are
// not falsely pruned. The runtime default stays 8000ms.
process.env.REQUEST_TIMEOUT_MS ??= "30000";

if (process.env.CI) {
  console.log("build-registry skipped: CI environment detected");
  process.exit(0);
}

const OUT = fileURLToPath(new URL("../data/companies.json", import.meta.url));
const CONCURRENCY = 16;

// Skip names already covered by code-level entries.
const covered = new Set(
  [...BASE_COMPANIES, APPLE].map((c) => c.name.toLowerCase()),
);
const candidates = CANDIDATES.filter((c) => !covered.has(c.name.toLowerCase()));

interface Job {
  candidate: Candidate;
  provider: (typeof BOARD_PROVIDERS)[number];
  token: string;
}

const jobs: Job[] = candidates.flatMap((candidate) => {
  const tokens = candidate.tokens ?? slugVariants(candidate.name);
  return tokens.flatMap((token) =>
    BOARD_PROVIDERS.map((provider) => ({ candidate, provider, token })),
  );
});

console.log(
  `Probing ${jobs.length} (token x provider) pairs for ${candidates.length} candidates ` +
    `(concurrency ${CONCURRENCY})...`,
);

const settled = await mapPool(jobs, CONCURRENCY, async (job) => ({
  job,
  probe: await probeBoard(job.provider, job.token),
}));

const byCandidate = new Map<string, ProbeResult[]>();
for (const result of settled) {
  if (result.status !== "fulfilled" || !result.value.probe) continue;
  const key = result.value.job.candidate.name;
  const list = byCandidate.get(key) ?? [];
  list.push(result.value.probe);
  byCandidate.set(key, list);
}

/**
 * Guard against slug collisions (our slug answering with someone else's
 * board): Greenhouse job payloads carry company_name, so compare it loosely
 * with the candidate name. Ashby/Lever payloads carry no company name — for
 * those, 200-with-jobs is the bar (known limit, noted in PLAN.md).
 */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
async function greenhouseNameMatches(candidate: string, token: string): Promise<boolean> {
  try {
    const data = (await fetchJson(
      `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`,
    )) as { jobs?: Array<{ company_name?: string }> };
    const boardName = data.jobs?.[0]?.company_name;
    if (!boardName) return true; // nothing to compare against
    const a = norm(candidate);
    const b = norm(boardName);
    return a.includes(b) || b.includes(a);
  } catch {
    return true; // transient failure: don't reject on the guard alone
  }
}

const verified: Array<{ name: string; provider: string; token: string; verified_at: string }> = [];
const failed: string[] = [];
const multiProvider: string[] = [];
const collisions: string[] = [];
const verifiedAt = new Date().toISOString().slice(0, 10);

for (const candidate of candidates) {
  const probes = byCandidate.get(candidate.name) ?? [];
  // Collapse per provider first (a candidate may verify under several slug
  // variants on one provider — keep that provider's liveliest token).
  const perProvider = BOARD_PROVIDERS.map((p) =>
    pickLiveliest(probes.filter((x) => x.provider === p)),
  ).filter((x): x is ProbeResult => x !== null);

  const best = pickLiveliest(perProvider);
  if (!best) {
    failed.push(candidate.name);
    continue;
  }
  if (best.provider === "greenhouse" && !(await greenhouseNameMatches(candidate.name, best.token))) {
    collisions.push(`${candidate.name} (greenhouse:${best.token} belongs to someone else)`);
    continue;
  }
  if (perProvider.length > 1) {
    const losers = perProvider
      .filter((p) => p !== best)
      .map((p) => `${p.provider}:${p.token}`)
      .join(", ");
    multiProvider.push(`${candidate.name}: kept ${best.provider}:${best.token}, discarded ${losers}`);
  }
  verified.push({
    name: candidate.name,
    provider: best.provider,
    token: best.token,
    verified_at: verifiedAt,
  });
}

verified.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(OUT, JSON.stringify(verified, null, 1) + "\n");

const byProvider = new Map<string, number>();
for (const v of verified) byProvider.set(v.provider, (byProvider.get(v.provider) ?? 0) + 1);

console.log(`\nWrote ${verified.length} verified boards to ${OUT}`);
console.log(`  by provider: ${[...byProvider].map(([p, n]) => `${p}=${n}`).join(", ")}`);
console.log(`\n${multiProvider.length} multi-provider picks:`);
for (const m of multiProvider) console.log(`  ${m}`);
if (collisions.length > 0) {
  console.log(`\n${collisions.length} dropped as probable slug collisions:`);
  for (const c of collisions) console.log(`  ${c}`);
}
console.log(`\n${failed.length} candidates did not verify:`);
console.log(`  ${failed.join(", ")}`);
