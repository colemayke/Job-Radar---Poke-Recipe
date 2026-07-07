# Poke Job Radar

An MCP server that gives [Poke](https://poke.com) a job radar: it watches the public careers
boards of a large registry of tech companies and reports which new roles matching your
filters have appeared since the last check. Poke owns the schedule and the texting; this
server owns fetching, filtering, deduping, and diffing. No third-party API keys.

## The registry model

[data/companies.json](data/companies.json) holds ~300 companies whose public Greenhouse,
Ashby, or Lever board APIs were verified live (biased toward AI, crypto, fintech, devtools,
and design-forward product companies, but broad across tech). The five originally verified
companies — Whop, Coinbase, Discord, Apple, The Interaction Company — are retained in
[src/companies.ts](src/companies.ts); Apple is a special-case adapter (no public JSON API —
its search page is parsed) that is always part of registry scans and isolated so its failure
never affects the rest.

**Coverage tradeoff:** the radar sees exactly the boards in the registry plus whatever you
add by name. A company using Workday, SmartRecruiters, or a custom careers site won't
resolve. Only boards that answered live with real postings are listed — nothing is guessed.

- `npm run build-registry` — re-verifies the curated candidate list
  ([scripts/candidates.ts](scripts/candidates.ts)) against the live board APIs and rewrites
  the registry. Cross-listed companies (answering on two providers) keep the board with the
  newest posting. Greenhouse picks are checked against the payload's `company_name` to catch
  slug collisions.
- `npm run verify-registry` — re-probes the existing registry, prunes dead tokens, refreshes
  `verified_at`.

Both are concurrency-limited and refuse to run when `CI=true`.

## Tools

| Tool | What it does |
|------|--------------|
| `create_watch` | Persist filters, seed the seen-set with current in-window matches, return a `watch_id`. Empty `companies` = whole registry; named companies are resolved to boards (live-probed if unknown), misses returned in `unresolved`. |
| `check_new_roles` | The scheduled tool: fan out over the watch's scope, dedupe, keep the freshness window, diff against the seen-set, return only new matches newest-first + an SMS-ready summary. Idempotent — each role is reported once. |
| `list_open_roles` | Stateless on-demand search (registry-wide or named companies). |
| `update_watch` | Change filters; changes that broaden the watch re-seed so the next check stays quiet. |
| `delete_watch` | Remove a watch and its history. |

Filters: `companies`, `keywords` (case-insensitive substring vs title + department; defaults:
design engineer / frontend / front end / product engineer / software engineer / ui engineer),
`locations` (substring vs location), `remote_only`, `posted_within_days` (default 21 — only
roles posted within the window are considered; roles without a posting date are treated as
posted now).

Responses cap at 25 roles, newest first, note truncation, and include `failed_count` /
`failed_sample` — one failing or slow board never fails a check. A full registry scan
(~300 boards, ~20k roles) completes in roughly 4–10 seconds with the default settings.

Note: at registry scale, Greenhouse boards are fetched without `content=true` (~10x lighter),
which means Greenhouse roles carry no department — keyword matching is effectively
title-only there.

## Local development

Requires Node.js 20.11+ (built on Node 24) and a Postgres database.

```bash
npm install
cp .env.example .env      # set DATABASE_URL
npm run dev               # serves POST /mcp on :3000
npm test                  # unit + MCP integration tests (offline, no DB needed)
npm run smoke             # hits the five original boards live
npm run smoke -- --all    # full registry fan-out with timing
```

### Test with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Choose transport "Streamable HTTP" and URL `http://localhost:3000/mcp`. If you set
`MCP_AUTH_TOKEN`, add an `Authorization: Bearer <token>` header.

### Connect to Poke

```bash
npx poke@latest tunnel http://localhost:3000/mcp -n "Job Radar" --recipe
```

Then tell Poke something like: *"Create a job watch for design engineer and frontend roles,
remote only. Every morning at 9, check my job watch and text me anything new."* Poke calls
`create_watch` once, stores the `watch_id`, and calls `check_new_roles` on its schedule.
Adding companies is just naming them: *"also watch Palantir"* — unknown names are resolved
against the three board APIs on the fly.

## Deploy to Railway

1. Create a Railway project and add the **Postgres** plugin (it injects `DATABASE_URL`).
2. Add this repo as a service. The included [Dockerfile](Dockerfile) is picked up
   automatically (Nixpacks also works: build `npm run build`, start `npm start`).
3. Optionally set `MCP_AUTH_TOKEN` in the service variables.
4. Deploy, then point Poke at `https://<your-service>.up.railway.app/mcp` — or publish the
   recipe from the Poke Kitchen.

The schema migrates itself on boot (idempotent `CREATE TABLE IF NOT EXISTS`), and the server
binds `process.env.PORT`, which Railway sets.

## Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | yes | Postgres connection string |
| `PORT` | no (3000) | HTTP port |
| `MCP_AUTH_TOKEN` | no | If set, `POST /mcp` requires `Authorization: Bearer <token>` |
| `FETCH_CONCURRENCY` | no (16) | Boards fetched in parallel during a scan |
| `REQUEST_TIMEOUT_MS` | no (8000) | Per-board request timeout; raise it to include very large, slow boards (e.g. SpaceX's ~2MB board can exceed 8s) |

## Layout

```
src/
  index.ts          entrypoint: env, Postgres pool, migration, listen
  app.ts            Express app, stateless Streamable HTTP /mcp endpoint, auth
  server.ts         McpServer + the five tools (zod schemas, text + structured output)
  companies.ts      registry loading/validation + original entries + name lookup
  resolve.ts        slug variants, live board probing, cross-listing pick
  pool.ts           hand-rolled bounded concurrency pool
  adapters/         greenhouse, lever, ashby, apple + bounded fan-out
  matching.ts       coarse filters, cross-source dedup, freshness window
  watches.ts        create/check/update/delete + narrowing pipeline + diff logic
  db.ts             pg store + idempotent migration
data/companies.json verified registry ({ name, provider, token, verified_at })
test/               vitest: adapters, matching/dedup/freshness, fan-out, registry,
                    watch diffing, resolution, MCP round-trip — all offline
scripts/            build-registry, verify-registry, candidates, smoke (all CI-guarded)
```
