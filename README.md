# Poke Job Radar

An MCP server that gives [Poke](https://poke.com) a job radar: it watches the public careers
boards of ~300 tech companies and reports new roles matching your filters since the last
check. Poke owns the scheduling and texting; this server fetches, filters, dedupes, and
diffs. No third-party API keys.

## How it works

- [data/companies.json](data/companies.json) is a registry of companies whose public
  Greenhouse, Ashby, or Lever board APIs were verified live. Apple is included as a
  special-case adapter. `npm run build-registry` rebuilds it; `npm run verify-registry`
  prunes dead boards.
- A watch scans either the whole registry or a custom set of companies. Unknown company
  names are resolved on the fly by probing the three board APIs.
- Each check fans out over the boards (bounded concurrency, per-board timeout, one failing
  board never fails a check), normalizes and dedupes roles, keeps only those posted within
  the watch's freshness window, applies keyword/location/remote filters, and diffs against
  a seen-set in Postgres so each role is only reported once.

## Tools

| Tool | What it does |
|------|--------------|
| `create_watch` | Save filters, seed the seen-set, return a `watch_id` |
| `check_new_roles` | The scheduled tool: return only new matching roles since last check |
| `list_open_roles` | Stateless on-demand search |
| `update_watch` / `delete_watch` | Change or remove a watch |

Filters: `companies`, `keywords`, `locations`, `remote_only`, `posted_within_days`.

Matching is function-agnostic: with no keywords, **no keyword filter is applied** — every
role in scope and inside the freshness window is a candidate, whatever the function
(engineering, marketing, design, ops, data) or career stage (internships and co-ops
included). This is intentionally broad; resume-fit narrowing is Poke's job. The two volume
levers are supplying `keywords` (e.g. `["marketing"]` or `["intern", "co-op", "new grad"]`,
matched as case-insensitive substrings of title and department) and tightening
`posted_within_days` (default 21). Responses are always capped at 25 roles, newest first.

## Running it

Requires Node.js 20.11+ and Postgres.

```bash
npm install
DATABASE_URL=postgres://... npm run dev   # serves POST /mcp on :3000
npm test
```

Environment: `DATABASE_URL` (required), `PORT` (default 3000), `MCP_AUTH_TOKEN` (optional
bearer auth on /mcp), `FETCH_CONCURRENCY` (default 16), `REQUEST_TIMEOUT_MS` (default 8000).

Test with `npx @modelcontextprotocol/inspector`, or connect to Poke:

```bash
npx poke@latest tunnel http://localhost:3000/mcp -n "Job Radar" --recipe
```

To deploy on Railway: add the Postgres plugin (provides `DATABASE_URL`), deploy with the
included Dockerfile, and point Poke at the public `/mcp` URL. The schema migrates itself
on boot.
