import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllRoles } from "../src/adapters/index.js";
import { mapPool } from "../src/pool.js";
import type { CompanyRef } from "../src/types.js";

const gh = (token: string): CompanyRef => ({ name: token, provider: "greenhouse", token });

const ghPayload = (id: number, title: string) =>
  JSON.stringify({
    jobs: [{ id, title, absolute_url: `https://x.example/${id}`, location: { name: "NYC" } }],
  });

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

/** A fetch stub that never resolves but honours AbortSignal, like a hung board. */
function hangingFetch(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason as Error));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.REQUEST_TIMEOUT_MS;
  delete process.env.FETCH_CONCURRENCY;
});

describe("mapPool", () => {
  it("runs everything with bounded concurrency and captures per-item errors", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (n === 4) throw new Error("boom");
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(7);
    expect(results[3]).toMatchObject({ status: "rejected" });
  });
});

describe("fetchAllRoles fan-out", () => {
  it("returns partial results with a failure count and sample", async () => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/boards/good1/")) return jsonResponse(ghPayload(1, "Engineer A"));
      if (u.includes("/boards/good2/")) return jsonResponse(ghPayload(2, "Engineer B"));
      return new Response("nope", { status: 500 });
    });
    const companies = [gh("good1"), gh("bad1"), gh("good2"), gh("bad2"), gh("bad3")];
    const result = await fetchAllRoles(companies, []);
    expect(result.roles.map((r) => r.title).sort()).toEqual(["Engineer A", "Engineer B"]);
    expect(result.failed_count).toBe(3);
    expect(result.failed_sample).toEqual(["bad1", "bad2", "bad3"]);
  });

  it("caps the failure sample at 5 names", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    const companies = Array.from({ length: 8 }, (_, i) => gh(`board${i}`));
    const result = await fetchAllRoles(companies, []);
    expect(result.failed_count).toBe(8);
    expect(result.failed_sample).toHaveLength(5);
  });

  it("times out a hung board without failing the rest", async () => {
    process.env.REQUEST_TIMEOUT_MS = "50";
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/boards/hung/")) return hangingFetch(init?.signal);
      return jsonResponse(ghPayload(1, "Engineer A"));
    });
    const result = await fetchAllRoles([gh("hung"), gh("good")], []);
    expect(result.roles).toHaveLength(1);
    expect(result.failed_count).toBe(1);
    expect(result.failed_sample).toEqual(["hung"]);
  });
});
