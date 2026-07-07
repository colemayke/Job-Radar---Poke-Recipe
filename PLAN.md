# Plan: Job Radar MCP Server (Poke recipe)

## v2: broad keyless ATS registry (this change)

Broaden from five fixed companies to a large verified registry of public Greenhouse /
Ashby / Lever boards, with on-the-fly company resolution by name. No third-party API keys.

### Registry

- `data/companies.json`: `{ name, provider, token, verified_at }[]`, built only from tokens
  that answered live with a non-empty board. First build (2026-07-07): 441 candidates,
  1677 (token x provider) probes, 297 verified (greenhouse 141, ashby 136, lever 20),
  18 cross-listing picks, 3 slug collisions caught by the Greenhouse company_name guard
  (e.g. greenhouse:intercom belongs to a different company). The registry maintenance
  scripts default REQUEST_TIMEOUT_MS to 30s (vs the 8s runtime default) so huge-but-alive
  boards like SpaceX's ~2MB one aren't falsely pruned. Loaded and zod-validated by
  `src/companies.ts`,
  merged with the five originally verified entries (which stay in code). Apple remains a
  code-level special case (not a JSON entry — it isn't a GH/Ashby/Lever board) and is always
  included in registry-scope scans; in custom scopes it participates only when named.
- `scripts/build-registry.ts`: probes a curated candidate list (~300+ names biased toward
  AI-native, crypto, fintech, devtools, design-forward, but broad) against all three provider
  APIs concurrently (bounded pool), keeps 200-with-jobs tokens, and writes the file plus a
  summary (verified / failed / multi-provider picks). Cross-listing rule: if a token answers
  on several providers, keep the one whose newest posting is most recent; the loser is noted
  in the build summary, not written as an entry. Greenhouse responses include `company_name`,
  which is loosely compared to the candidate name to catch slug collisions (someone else's
  board on our slug); mismatches are dropped and reported. Ashby/Lever have no name field in
  the payload, so 200-with-jobs is the bar there — flagged as a known limit.
- `scripts/verify-registry.ts`: re-probes every entry in the file, prunes dead tokens,
  refreshes `verified_at`, reports adds/prunes/provider switches. Both scripts refuse to run
  when `CI=true` and share the probe/pool code with the server (`src/resolve.ts`,
  `src/pool.ts`).

### Fan-out guardrails (`src/adapters/index.ts`)

- Hand-rolled concurrency pool (no new deps), default 16 in flight, `FETCH_CONCURRENCY` env
  override. Per-request timeout via AbortController, default 8000ms, `REQUEST_TIMEOUT_MS`.
- Per-board try/catch as before, but failures now aggregate to
  `{ roles, failed_count, failed_sample }` (sample capped at 5 names) instead of a full list.
- Registry-scale Greenhouse fetches use the plain `/jobs` endpoint (verified live: it carries
  `first_published` + `company_name`; `content=true` is ~10x the bytes — 1.5MB vs 150KB for
  Coinbase). Tradeoff: no departments/offices without content, so Greenhouse roles have
  `department: null` (keyword match is title-only there) and remote detection uses the
  location string.

### Normalization, dedup, freshness

- Role id becomes `${provider}:${token}:${sourceJobId}` (stable, globally unique).
- Cross-source dedupe before diffing: `dedupe_key = companyLower|titleLower|locationLower`,
  first occurrence wins, so a company alive on two providers can't double-report.
- Posting-date fields confirmed live on 2026-07-07: Greenhouse `first_published`, Ashby
  `publishedAt`, Lever `createdAt` (epoch ms) → normalized to `posted_at` (ISO). New watch
  field `posted_within_days` (default 21) restricts consideration to fresh roles. A role with
  no posted date is treated as posted now — it can't be excluded by the window, but the
  seen-set still prevents repeat reporting.

### Watch model

`watches.config` (jsonb, no migration) gains: `scope: "registry" | "custom"`, `companies` as
resolved `{ name, provider, token }` refs (custom scope), `posted_within_days`. Existing
five-company watches from v1 configs are not migrated (nothing deployed yet).

- `create_watch` / `update_watch` accept plain company names. Resolution order: registry
  match, else slugify + live-probe all three providers (same newest-posting rule); resolved
  refs are persisted in the config so checks never re-resolve; unresolvable names come back
  in `unresolved`. Empty `companies` = registry scope.
- Seeding: create seeds the seen-set with all in-window roles passing the coarse filter, so
  the first scheduled check is quiet. `update_watch` re-seeds whenever the change could
  broaden matches (companies/keywords/locations changed, remote_only switched off, window
  grew).
- `check_new_roles`: fetch scope with the pool → normalize → dedupe → freshness window →
  coarse filter → diff via `INSERT ... ON CONFLICT DO NOTHING RETURNING` → new roles sorted
  `posted_at` desc, capped at 25 with truncation note + failure summary.
- `list_open_roles`: stateless, same fetch/filter path, newest first. `delete_watch`
  unchanged.

### Tests (all offline, fixtures only)

Registry load/validation; pool partial-failure and timeout behaviour; cross-provider dedupe;
freshness + diff (out-of-window ignored, new in-window role reported exactly once across two
providers, seen role never re-reported); name resolution (resolvable persisted, unresolvable
returned); existing SDK-client integration test stays green.

---

## v1 (original five-company design, superseded where v2 says otherwise)

MCP server over Streamable HTTP that lets Poke watch company job boards and report new
postings. Poke owns scheduling/messaging; this server owns fetching, filtering, and diffing.

## Verified company → ATS mapping (checked live, 2026-07-07)

| Company     | Provider   | Token / endpoint | Evidence |
|-------------|-----------|------------------|----------|
| Coinbase    | Greenhouse | `coinbase`       | `boards-api.greenhouse.io/v1/boards/coinbase/jobs` → 200 with jobs |
| Discord     | Greenhouse | `discord`        | same, 200 with jobs |
| Whop        | Ashby      | `whop`           | careers.whop.com links to `jobs.ashbyhq.com/whop`. NOTE: a legacy Greenhouse board `whop` also still answers 200 — the live careers site uses Ashby, so Ashby wins. |
| Interaction | Ashby      | `interaction`    | interaction.co/careers links to `jobs.ashbyhq.com/interaction` |
| Apple       | custom     | `jobs.apple.com/en-us/search?search=<kw>&sort=newest` | `POST /api/v1/search` returns 200 but empty for anonymous clients; the search page server-renders results in `window.__staticRouterHydrationData` (JSON), 20/page, fields: `positionId`, `postingTitle`, `postingDate`, `team.teamName`, `locations[].name`, `homeOffice`, `transformedPostingTitle`. Adapter parses that. Best-effort, isolated. |

Apple caveat: the board has ~5.5k postings, so the Apple adapter is search-driven — it runs one
newest-sorted query per keyword (watch keywords or the defaults) and dedupes, rather than
fetching "all roles". Other adapters return the full board and filtering happens in code.

## File structure

```
src/
  index.ts            entry: env, pg pool, migration, listen
  app.ts              express app factory: POST /mcp (Streamable HTTP), optional bearer auth
  server.ts           McpServer construction + tool registration
  db.ts               pg Pool, idempotent migration (CREATE TABLE IF NOT EXISTS)
  companies.ts        verified company -> { provider, token } map
  types.ts            Role, WatchConfig, ProviderResult
  matching.ts         keyword/location/remote filters + DEFAULT_KEYWORDS
  format.ts           SMS-style text block, 25-role cap w/ truncation note
  watches.ts          create/check/update/delete logic (seen-set diffing)
  adapters/
    index.ts          fetchAllRoles(companies, keywords): per-adapter catch, partial results
    greenhouse.ts     boards-api.greenhouse.io
    lever.ts          api.lever.co (no current company uses it; kept per spec, fixture-tested)
    ashby.ts          api.ashbyhq.com/posting-api
    apple.ts          jobs.apple.com hydration-data parser (never throws out of the module)
test/
  fixtures/           one recorded real response per provider
  *.test.ts           adapter normalization tests + check_new_roles diff test
scripts/smoke.ts      hits real boards, prints counts; refuses to run when CI=true
Dockerfile, .env.example, README.md, PLAN.md
```

## Dependencies

Runtime: `@modelcontextprotocol/sdk`, `express`, `pg`, `zod`, `nanoid`.
Dev: `typescript` (strict), `vitest`, `tsx`, `@types/express`, `@types/pg`, `@types/node`.
SDK transport/API surface will be confirmed against installed `node_modules` before coding.

## Tool contract (all return text block + structured JSON, ≤25 roles, truncation noted)

- `create_watch { companies?, keywords?, locations?, remote_only? }` → persist config, seed
  `seen_roles` with everything currently open, return `{ watch_id, matched_now }`.
- `check_new_roles { watch_id }` → fetch, filter, diff vs seen-set, insert new ids
  (`ON CONFLICT DO NOTHING` keeps it idempotent), return only new roles + SMS summary +
  `failed_sources`.
- `list_open_roles { companies?, keywords?, locations?, remote_only? }` → stateless search.
- `update_watch { watch_id, ...partial }`, `delete_watch { watch_id }`.

Matching: case-insensitive substring; keywords vs title+department, locations vs location,
`remote_only` keeps `remote === true` or "remote" in location. Default keywords: design
engineer, frontend, front end, product engineer, software engineer, ui engineer.

## Data model (per spec)

`watches(watch_id pk, config jsonb, created_at)` and
`seen_roles(watch_id, role_id, first_seen, pk(watch_id, role_id))`. watch_id = nanoid.

## Order of work

1. Scaffold (package.json, tsconfig strict, deps) and confirm SDK transport API.
2. Adapters + fixtures + unit tests.
3. DB layer + watch logic + diff test.
4. MCP server + tools + express wiring.
5. Smoke script, Dockerfile, README, .env.example.
