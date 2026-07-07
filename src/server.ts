import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RoleFetcher } from "./adapters/index.js";
import { registryScope } from "./companies.js";
import { formatRoles } from "./format.js";
import {
  DEFAULT_POSTED_WITHIN_DAYS,
  dedupeRoles,
  filterRoles,
  sortNewestFirst,
} from "./matching.js";
import type { WatchConfig } from "./types.js";
import { WatchService } from "./watches.js";

const filterShape = {
  companies: z
    .array(z.string())
    .optional()
    .describe(
      "Company names to include, e.g. ['Stripe', 'Linear']. Names not in the built-in " +
        "registry are resolved live against the public Greenhouse/Ashby/Lever board APIs, " +
        "so most tech companies work. Omit or pass [] to scan the whole registry " +
        "(hundreds of companies).",
    ),
  keywords: z
    .array(z.string())
    .optional()
    .describe(
      "Keywords matched case-insensitively as substrings of title and department. Omit for " +
        "NO keyword filter: every role of every function (engineering, marketing, design, " +
        "ops, internships, co-ops, ...) is a candidate. Pass keywords to narrow to a " +
        'function ("marketing", "data") or career stage ("intern", "co-op", "new grad").',
    ),
  locations: z
    .array(z.string())
    .optional()
    .describe(
      'Locations matched case-insensitively as substrings of the role location, e.g. "New York", "London", "Remote".',
    ),
  remote_only: z
    .boolean()
    .optional()
    .describe("If true, only keep roles flagged remote or with 'remote' in the location."),
};

const postedWithinShape = {
  posted_within_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      `Only consider roles posted within this many days (default ${DEFAULT_POSTED_WITHIN_DAYS}).`,
    ),
};

const roleShape = z.object({
  id: z.string(),
  company: z.string(),
  title: z.string(),
  location: z.string().nullable(),
  remote: z.boolean(),
  department: z.string().nullable(),
  url: z.string(),
  posted_at: z.string().nullable(),
  source: z.string(),
});

const configShape = z.object({
  scope: z.enum(["registry", "custom"]),
  companies: z.array(z.object({ name: z.string(), provider: z.string(), token: z.string() })),
  keywords: z.array(z.string()),
  locations: z.array(z.string()),
  remote_only: z.boolean(),
  posted_within_days: z.number(),
});

function ok(text: string, structured: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured,
  };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function failureNote(count: number, sample: string[]): string {
  if (count === 0) return "";
  return `\nNote: ${count} board${count === 1 ? "" : "s"} unreachable this check (e.g. ${sample.join(", ")}).`;
}

function unresolvedNote(unresolved: string[]): string {
  if (unresolved.length === 0) return "";
  return `\nCould not find a careers board for: ${unresolved.join(", ")}.`;
}

export function buildServer(service: WatchService, fetchRoles: RoleFetcher): McpServer {
  const server = new McpServer({ name: "poke-job-radar", version: "2.0.0" });
  const registrySize = registryScope().length;

  server.registerTool(
    "create_watch",
    {
      title: "Create job watch",
      description:
        "Create a persistent job watch. By default it scans the whole built-in registry " +
        `(~${registrySize} companies with verified public job boards: AI, crypto, fintech, ` +
        "devtools, design-forward product, and broader tech). Pass company names to watch " +
        "a custom set instead — unknown names are resolved live and unresolvable ones are " +
        "returned in `unresolved`. Seeds the seen-set with all current in-window matches so " +
        "the first scheduled check is quiet. Returns the watch_id needed by " +
        "check_new_roles — keep it. Use once when the user asks to start watching for jobs. " +
        "An empty keyword set is intentionally broad (all functions, including internships " +
        "and co-ops); the two volume levers are supplying keywords and tightening " +
        "posted_within_days.",
      inputSchema: { ...filterShape, ...postedWithinShape },
      outputSchema: {
        watch_id: z.string(),
        matched_now: z.number().describe("How many current in-window roles match the filters"),
        unresolved: z.array(z.string()),
        failed_count: z.number(),
        failed_sample: z.array(z.string()),
      },
    },
    async (input) => {
      const result = await service.create(input);
      if ("error" in result) {
        return fail(
          `None of those companies resolved to a public job board: ${result.unresolved.join(", ")}. ` +
            "The watch was not created. Try different names, or omit companies to scan the whole registry.",
        );
      }
      const { watchId, matchedNow, failedCount, failedSample, unresolved, config } = result;
      const scopeDesc =
        config.scope === "registry"
          ? `the full ${registrySize}-company registry`
          : `${config.companies.length} companies (${config.companies.map((c) => c.name).join(", ")})`;
      const text =
        `Watch created (id: ${watchId}), scanning ${scopeDesc}. ${matchedNow.length} current ` +
        `roles (posted within ${config.posted_within_days} days) match your filters; you'll ` +
        "only be told about roles that appear from now on." +
        unresolvedNote(unresolved) +
        failureNote(failedCount, failedSample);
      return ok(text, {
        watch_id: watchId,
        matched_now: matchedNow.length,
        unresolved,
        failed_count: failedCount,
        failed_sample: failedSample,
      });
    },
  );

  server.registerTool(
    "check_new_roles",
    {
      title: "Check for new roles",
      description:
        "Check a watch for job postings that are new since the last check. This is the " +
        "tool to call on a schedule (e.g. every morning). Returns only fresh roles " +
        "(within the watch's posted_within_days window) that were never reported before " +
        "and match the watch filters, newest first, plus a short text summary ready to " +
        "send as a message. Safe to call repeatedly: each role is reported once.",
      inputSchema: {
        watch_id: z.string().describe("The watch_id returned by create_watch"),
      },
      outputSchema: {
        new_roles: z.array(roleShape),
        total_new: z.number(),
        truncated: z.boolean(),
        failed_count: z.number(),
        failed_sample: z.array(z.string()),
      },
    },
    async ({ watch_id }) => {
      const result = await service.check(watch_id);
      if (!result) return fail(`No watch found with id ${watch_id}. Create one with create_watch.`);
      const { newRoles, failedCount, failedSample } = result;
      if (newRoles.length === 0) {
        return ok(
          `No new matching roles since the last check.${failureNote(failedCount, failedSample)}`,
          {
            new_roles: [],
            total_new: 0,
            truncated: false,
            failed_count: failedCount,
            failed_sample: failedSample,
          },
        );
      }
      const header = `${newRoles.length} new matching role${newRoles.length === 1 ? "" : "s"}:`;
      const { text, capped, truncated } = formatRoles(newRoles, header);
      return ok(text + failureNote(failedCount, failedSample), {
        new_roles: capped,
        total_new: newRoles.length,
        truncated,
        failed_count: failedCount,
        failed_sample: failedSample,
      });
    },
  );

  server.registerTool(
    "list_open_roles",
    {
      title: "List open roles",
      description:
        "One-off search of currently open roles with optional filters — across the whole " +
        `~${registrySize}-company registry, or a named set of companies (unknown names are ` +
        "resolved live). Stateless: nothing is stored and no watch is touched. Use for " +
        "questions like 'what frontend roles are open at Stripe right now?'.",
      inputSchema: filterShape,
      outputSchema: {
        roles: z.array(roleShape),
        total: z.number(),
        truncated: z.boolean(),
        unresolved: z.array(z.string()),
        failed_count: z.number(),
        failed_sample: z.array(z.string()),
      },
    },
    async (input) => {
      const names = input.companies ?? [];
      const { refs, unresolved } = await service.resolveNames(names);
      if (names.length > 0 && refs.length === 0) {
        return fail(
          `None of those companies resolved to a public job board: ${unresolved.join(", ")}.`,
        );
      }
      const scope = names.length > 0 ? refs : registryScope();
      const config: WatchConfig = {
        scope: names.length > 0 ? "custom" : "registry",
        companies: refs,
        keywords: input.keywords ?? [],
        locations: input.locations ?? [],
        remote_only: input.remote_only ?? false,
        posted_within_days: DEFAULT_POSTED_WITHIN_DAYS,
      };
      const { roles, failed_count, failed_sample } = await fetchRoles(
        scope,
        config.keywords,
      );
      const matches = sortNewestFirst(filterRoles(dedupeRoles(roles), config));
      if (matches.length === 0) {
        return ok(
          `No currently open roles match those filters.${unresolvedNote(unresolved)}${failureNote(failed_count, failed_sample)}`,
          {
            roles: [],
            total: 0,
            truncated: false,
            unresolved,
            failed_count,
            failed_sample,
          },
        );
      }
      const { text, capped, truncated } = formatRoles(
        matches,
        `${matches.length} matching open role${matches.length === 1 ? "" : "s"}:`,
      );
      return ok(text + unresolvedNote(unresolved) + failureNote(failed_count, failed_sample), {
        roles: capped,
        total: matches.length,
        truncated,
        unresolved,
        failed_count,
        failed_sample,
      });
    },
  );

  server.registerTool(
    "update_watch",
    {
      title: "Update job watch",
      description:
        "Change a watch's filters (companies, keywords, locations, remote_only, " +
        "posted_within_days). Only the fields provided are changed; pass companies: [] to " +
        "switch back to the whole registry. Changes that broaden the watch re-seed the " +
        "seen-set so the next check still only reports genuinely new postings.",
      inputSchema: {
        watch_id: z.string().describe("The watch_id returned by create_watch"),
        ...filterShape,
        ...postedWithinShape,
      },
      outputSchema: {
        watch_id: z.string(),
        config: configShape,
        unresolved: z.array(z.string()),
      },
    },
    async ({ watch_id, ...input }) => {
      const result = await service.update(watch_id, input);
      if (!result) return fail(`No watch found with id ${watch_id}.`);
      const { config, unresolved } = result;
      const desc = [
        config.scope === "registry"
          ? `the full ${registrySize}-company registry`
          : `companies: ${config.companies.map((c) => c.name).join(", ")}`,
        config.keywords.length > 0 ? `keywords: ${config.keywords.join(", ")}` : "keywords: defaults",
        config.locations.length > 0 ? `locations: ${config.locations.join(", ")}` : null,
        config.remote_only ? "remote only" : null,
        `posted within ${config.posted_within_days} days`,
      ]
        .filter(Boolean)
        .join("; ");
      return ok(`Watch ${watch_id} updated. Now watching ${desc}.${unresolvedNote(unresolved)}`, {
        watch_id,
        config,
        unresolved,
      });
    },
  );

  server.registerTool(
    "delete_watch",
    {
      title: "Delete job watch",
      description:
        "Delete a watch and its seen-roles history. Use when the user wants to stop the job radar.",
      inputSchema: {
        watch_id: z.string().describe("The watch_id returned by create_watch"),
      },
      outputSchema: { deleted: z.boolean() },
    },
    async ({ watch_id }) => {
      const deleted = await service.delete(watch_id);
      if (!deleted) return fail(`No watch found with id ${watch_id}.`);
      return ok(`Watch ${watch_id} deleted.`, { deleted: true });
    },
  );

  return server;
}
