/**
 * Re-checks every entry in data/companies.json against the live board APIs,
 * prunes tokens that no longer answer with jobs, refreshes verified_at, and
 * reports what changed. Never runs in CI.
 *
 *   npm run verify-registry
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapPool } from "../src/pool.js";
import { probeBoard, type BoardProvider } from "../src/resolve.js";

// Verification cares about board existence, not latency: default to a
// generous per-request timeout so huge-but-alive boards (SpaceX, ~2MB) are
// not falsely pruned. The runtime default stays 8000ms.
process.env.REQUEST_TIMEOUT_MS ??= "30000";

if (process.env.CI) {
  console.log("verify-registry skipped: CI environment detected");
  process.exit(0);
}

const PATH = fileURLToPath(new URL("../data/companies.json", import.meta.url));
const CONCURRENCY = 16;

interface Entry {
  name: string;
  provider: BoardProvider;
  token: string;
  verified_at: string;
}

const entries = JSON.parse(readFileSync(PATH, "utf8")) as Entry[];
console.log(`Re-verifying ${entries.length} registry entries (concurrency ${CONCURRENCY})...`);

const today = new Date().toISOString().slice(0, 10);
const settled = await mapPool(entries, CONCURRENCY, async (entry) => ({
  entry,
  probe: await probeBoard(entry.provider, entry.token),
}));

const kept: Entry[] = [];
const pruned: string[] = [];
for (const result of settled) {
  if (result.status !== "fulfilled") continue;
  const { entry, probe } = result.value;
  if (probe) {
    kept.push({ ...entry, verified_at: today });
  } else {
    pruned.push(`${entry.name} (${entry.provider}:${entry.token})`);
  }
}

kept.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(PATH, JSON.stringify(kept, null, 1) + "\n");

console.log(`\nKept ${kept.length}, pruned ${pruned.length}.`);
if (pruned.length > 0) {
  console.log("Pruned entries:");
  for (const p of pruned) console.log(`  ${p}`);
}
