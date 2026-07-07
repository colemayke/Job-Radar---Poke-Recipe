import { describe, expect, it } from "vitest";
import type { RoleFetcher } from "../src/adapters/index.js";
import type { CompanyResolver } from "../src/resolve.js";
import type { CompanyRef, Role } from "../src/types.js";
import { WatchService } from "../src/watches.js";
import { MemoryStore } from "./helpers/memoryStore.js";

const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const mkRole = (id: string, over: Partial<Role> = {}): Role => ({
  id,
  company: "Coinbase",
  title: "Software Engineer",
  location: "Remote - USA",
  remote: true,
  department: "Engineering",
  url: `https://x.example/${id}`,
  posted_at: daysAgo(1),
  source: "greenhouse",
  ...over,
});

interface Board {
  roles: Role[];
  failed_count?: number;
  failed_sample?: string[];
}

function fetcherFor(board: Board): RoleFetcher {
  return async () => ({
    roles: board.roles,
    failed_count: board.failed_count ?? 0,
    failed_sample: board.failed_sample ?? [],
  });
}

const noResolver: CompanyResolver = async () => null;

function service(board: Board, resolver: CompanyResolver = noResolver) {
  const store = new MemoryStore();
  return new WatchService(store, fetcherFor(board), resolver);
}

describe("WatchService diff behaviour", () => {
  it("seeds on create, then reports only roles added afterwards, exactly once", async () => {
    const board: Board = {
      roles: [
        mkRole("greenhouse:coinbase:1"),
        mkRole("greenhouse:coinbase:2", { title: "Senior Software Engineer" }),
      ],
    };
    const svc = service(board);

    const created = await svc.create({ companies: ["coinbase"] });
    if ("error" in created) throw new Error("unexpected");
    expect(created.matchedNow).toHaveLength(2);
    expect(created.config.scope).toBe("custom");

    const first = await svc.check(created.watchId);
    expect(first?.newRoles).toEqual([]);

    board.roles = [...board.roles, mkRole("greenhouse:coinbase:3", { title: "Design Engineer" })];
    const second = await svc.check(created.watchId);
    expect(second?.newRoles.map((r) => r.id)).toEqual(["greenhouse:coinbase:3"]);

    const third = await svc.check(created.watchId);
    expect(third?.newRoles).toEqual([]);
  });

  it("ignores roles posted outside the freshness window", async () => {
    const board: Board = { roles: [mkRole("greenhouse:coinbase:1")] };
    const svc = service(board);
    const created = await svc.create({ posted_within_days: 21 });
    if ("error" in created) throw new Error("unexpected");

    board.roles = [
      ...board.roles,
      mkRole("greenhouse:coinbase:old", { title: "Frontend Engineer", posted_at: daysAgo(40) }),
      mkRole("greenhouse:coinbase:new", { title: "Frontend Engineer 2", posted_at: daysAgo(2) }),
    ];
    const result = await svc.check(created.watchId);
    expect(result?.newRoles.map((r) => r.id)).toEqual(["greenhouse:coinbase:new"]);
  });

  it("reports a role seen from two providers exactly once (cross-source dedup)", async () => {
    const board: Board = { roles: [] };
    const svc = service(board);
    const created = await svc.create({});
    if ("error" in created) throw new Error("unexpected");

    // The same posting surfaces on a live Ashby board AND a legacy Greenhouse board.
    board.roles = [
      mkRole("ashby:whop:1", { company: "Whop", title: "Design Engineer", source: "ashby" }),
      mkRole("greenhouse:whop:77", { company: "Whop", title: "Design Engineer", source: "greenhouse" }),
    ];
    const result = await svc.check(created.watchId);
    expect(result?.newRoles).toHaveLength(1);
    expect(result?.newRoles[0]!.id).toBe("ashby:whop:1");

    const again = await svc.check(created.watchId);
    expect(again?.newRoles).toEqual([]);
  });

  it("sorts new roles newest first", async () => {
    const board: Board = { roles: [] };
    const svc = service(board);
    const created = await svc.create({});
    if ("error" in created) throw new Error("unexpected");

    board.roles = [
      mkRole("g:a:1", { company: "A", title: "Frontend Engineer", posted_at: daysAgo(5) }),
      mkRole("g:b:2", { company: "B", title: "Frontend Engineer", posted_at: daysAgo(1) }),
      mkRole("g:c:3", { company: "C", title: "Frontend Engineer", posted_at: daysAgo(3) }),
    ];
    const result = await svc.check(created.watchId);
    expect(result?.newRoles.map((r) => r.id)).toEqual(["g:b:2", "g:c:3", "g:a:1"]);
  });

  it("does not report new roles that fail the coarse filters", async () => {
    const board: Board = { roles: [mkRole("greenhouse:coinbase:1")] };
    const svc = service(board);
    const created = await svc.create({ keywords: ["design engineer"] });
    if ("error" in created) throw new Error("unexpected");

    board.roles = [...board.roles, mkRole("greenhouse:coinbase:2", { title: "Account Executive" })];
    const result = await svc.check(created.watchId);
    expect(result?.newRoles).toEqual([]);
  });

  it("passes the failure summary through", async () => {
    const board: Board = {
      roles: [mkRole("greenhouse:coinbase:1")],
      failed_count: 12,
      failed_sample: ["Apple", "Stripe", "Linear"],
    };
    const svc = service(board);
    const created = await svc.create({});
    if ("error" in created) throw new Error("unexpected");
    const result = await svc.check(created.watchId);
    expect(result?.failedCount).toBe(12);
    expect(result?.failedSample).toEqual(["Apple", "Stripe", "Linear"]);
  });

  it("returns null for unknown watch ids", async () => {
    const svc = service({ roles: [] });
    expect(await svc.check("nope")).toBeNull();
  });
});

describe("company resolution", () => {
  it("resolves registry names without calling the live resolver", async () => {
    let liveCalls = 0;
    const resolver: CompanyResolver = async () => {
      liveCalls++;
      return null;
    };
    const svc = service({ roles: [] }, resolver);
    const { refs, unresolved } = await svc.resolveNames(["coinbase", "interaction"]);
    expect(refs.map((r) => r.token)).toEqual(["coinbase", "interaction"]);
    expect(unresolved).toEqual([]);
    expect(liveCalls).toBe(0);
  });

  it("resolves unknown names live and persists the refs in the watch config", async () => {
    const stripe: CompanyRef = { name: "Stripe", provider: "greenhouse", token: "stripe" };
    const resolver: CompanyResolver = async (name) =>
      name.toLowerCase() === "stripe" ? stripe : null;
    const store = new MemoryStore();
    const svc = new WatchService(store, fetcherFor({ roles: [] }), resolver);

    const created = await svc.create({ companies: ["Stripe", "Bogus Nonexistent Co"] });
    if ("error" in created) throw new Error("unexpected");
    expect(created.unresolved).toEqual(["Bogus Nonexistent Co"]);
    expect(created.config.companies).toEqual([stripe]);
    // persisted: later checks use the stored ref, no re-resolution
    expect((await store.getWatch(created.watchId))?.companies).toEqual([stripe]);
  });

  it("refuses to create a custom watch when nothing resolves", async () => {
    const svc = service({ roles: [] });
    const created = await svc.create({ companies: ["Bogus Nonexistent Co"] });
    expect(created).toEqual({ error: "nothing_resolved", unresolved: ["Bogus Nonexistent Co"] });
  });
});

describe("update re-seeding", () => {
  it("re-seeds when companies are added so the next check stays quiet", async () => {
    const board: Board = { roles: [mkRole("greenhouse:coinbase:1")] };
    const whop: CompanyRef = { name: "Whop", provider: "ashby", token: "whop" };
    const resolver: CompanyResolver = async () => whop;
    const svc = service(board, resolver);

    const created = await svc.create({ companies: ["coinbase"] });
    if ("error" in created) throw new Error("unexpected");

    board.roles = [
      ...board.roles,
      mkRole("ashby:whop:1", { company: "Whop", source: "ashby" }),
      mkRole("ashby:whop:2", { company: "Whop", title: "Frontend Engineer", source: "ashby" }),
    ];
    await svc.update(created.watchId, { companies: ["coinbase", "whop"] });
    const result = await svc.check(created.watchId);
    expect(result?.newRoles).toEqual([]);
  });

  it("re-seeds when keywords broaden", async () => {
    const board: Board = { roles: [mkRole("greenhouse:coinbase:1")] };
    const svc = service(board);
    const created = await svc.create({ keywords: ["design engineer"] });
    if ("error" in created) throw new Error("unexpected");

    // This role exists before the keyword change; broadening must not surface it.
    board.roles = [...board.roles, mkRole("greenhouse:coinbase:2", { title: "Account Executive" })];
    await svc.update(created.watchId, { keywords: ["account executive"] });
    const result = await svc.check(created.watchId);
    expect(result?.newRoles).toEqual([]);

    // But a genuinely new role matching the new keywords is reported.
    board.roles = [...board.roles, mkRole("greenhouse:coinbase:3", { title: "Account Executive II" })];
    const after = await svc.check(created.watchId);
    expect(after?.newRoles.map((r) => r.id)).toEqual(["greenhouse:coinbase:3"]);
  });

  it("re-seeds when the freshness window grows", async () => {
    const board: Board = {
      roles: [
        mkRole("greenhouse:coinbase:1"),
        mkRole("greenhouse:coinbase:old", { title: "Frontend Engineer", posted_at: daysAgo(30) }),
      ],
    };
    const svc = service(board);
    const created = await svc.create({ posted_within_days: 21 });
    if ("error" in created) throw new Error("unexpected");

    await svc.update(created.watchId, { posted_within_days: 60 });
    const result = await svc.check(created.watchId);
    expect(result?.newRoles).toEqual([]);
  });

  it("returns null for unknown watch ids and keeps unresolved names", async () => {
    const svc = service({ roles: [] });
    expect(await svc.update("nope", {})).toBeNull();
  });
});
