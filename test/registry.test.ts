import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRegistryFile } from "../src/companies.js";

const write = (data: unknown): string => {
  const path = join(mkdtempSync(join(tmpdir(), "registry-")), "companies.json");
  writeFileSync(path, JSON.stringify(data));
  return path;
};

describe("registry file loading", () => {
  it("loads and strips a valid registry file", () => {
    const path = write([
      { name: "Stripe", provider: "greenhouse", token: "stripe", verified_at: "2026-07-07" },
      { name: "Ramp", provider: "ashby", token: "ramp", verified_at: "2026-07-07" },
    ]);
    expect(loadRegistryFile(path)).toEqual([
      { name: "Stripe", provider: "greenhouse", token: "stripe" },
      { name: "Ramp", provider: "ashby", token: "ramp" },
    ]);
  });

  it("rejects unknown providers", () => {
    const path = write([
      { name: "X", provider: "workday", token: "x", verified_at: "2026-07-07" },
    ]);
    expect(() => loadRegistryFile(path)).toThrow();
  });

  it("rejects entries missing fields", () => {
    const path = write([{ name: "X", provider: "greenhouse" }]);
    expect(() => loadRegistryFile(path)).toThrow();
  });

  it("rejects non-array files", () => {
    const path = write({ companies: [] });
    expect(() => loadRegistryFile(path)).toThrow();
  });
});
