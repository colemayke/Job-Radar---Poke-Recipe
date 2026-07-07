/**
 * Manual smoke test. Never runs in CI.
 *
 *   npm run smoke             # the five original boards, individually
 *   npm run smoke -- --all    # full registry fan-out with timing
 */
import { fetchAllRoles } from "../src/adapters/index.js";
import { APPLE, BASE_COMPANIES, registryScope } from "../src/companies.js";
import { roleLine } from "../src/format.js";

// Empty keywords = the match-all path (Apple fetches its unfiltered newest pages).
const NO_KEYWORDS: string[] = [];

if (process.env.CI) {
  console.log("smoke test skipped: CI environment detected");
  process.exit(0);
}

const originals = [...BASE_COMPANIES, APPLE];
console.log(`Fetching live boards for: ${originals.map((c) => c.name).join(", ")}\n`);

for (const company of originals) {
  const { roles, failed_count } = await fetchAllRoles([company], NO_KEYWORDS);
  if (failed_count > 0) {
    console.log(`✗ ${company.name}: FAILED`);
    continue;
  }
  console.log(`✓ ${company.name} (${company.provider}): ${roles.length} roles`);
  const sample = roles[0];
  if (sample) console.log(`    e.g. ${roleLine(sample)}`);
}

if (process.argv.includes("--all")) {
  const scope = registryScope();
  console.log(`\nFull registry fan-out: ${scope.length} boards...`);
  const started = Date.now();
  const { roles, failed_count, failed_sample } = await fetchAllRoles(scope, NO_KEYWORDS);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `${roles.length} roles from ${scope.length - failed_count}/${scope.length} boards in ${secs}s` +
      (failed_count > 0 ? ` (${failed_count} failed, e.g. ${failed_sample.join(", ")})` : ""),
  );
}
