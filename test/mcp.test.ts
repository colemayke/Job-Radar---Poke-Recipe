import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RoleFetcher } from "../src/adapters/index.js";
import { createApp } from "../src/app.js";
import type { Role } from "../src/types.js";
import { WatchService } from "../src/watches.js";
import { MemoryStore } from "./helpers/memoryStore.js";

const board: { roles: Role[] } = {
  roles: [
    {
      id: "greenhouse:coinbase:1",
      company: "Coinbase",
      title: "Design Engineer",
      location: "Remote - USA",
      remote: true,
      department: "Engineering",
      url: "https://x.example/1",
      posted_at: null,
      source: "greenhouse",
    },
  ],
};
const fetcher: RoleFetcher = async () => ({ roles: board.roles, failed_count: 0, failed_sample: [] });
const noResolver = async () => null;

let server: Server;
let url: string;

beforeAll(async () => {
  const app = createApp(new WatchService(new MemoryStore(), fetcher, noResolver), fetcher, "secret-token");
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  url = `http://127.0.0.1:${addr.port}/mcp`;
});

afterAll(() => server?.close());

async function connect(token?: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

describe("MCP server over Streamable HTTP", () => {
  it("rejects requests without the bearer token when MCP_AUTH_TOKEN is set", async () => {
    await expect(connect()).rejects.toThrow(/Unauthorized/);
  });

  it("exposes the five tools", async () => {
    const client = await connect("secret-token");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_new_roles",
      "create_watch",
      "delete_watch",
      "list_open_roles",
      "update_watch",
    ]);
    await client.close();
  });

  it("runs the create -> check -> new-role -> check flow end to end", async () => {
    const client = await connect("secret-token");

    const created = await client.callTool({ name: "create_watch", arguments: {} });
    const { watch_id, matched_now } = created.structuredContent as {
      watch_id: string;
      matched_now: number;
    };
    expect(watch_id).toBeTruthy();
    expect(matched_now).toBe(1);

    const quiet = await client.callTool({
      name: "check_new_roles",
      arguments: { watch_id },
    });
    expect((quiet.structuredContent as { total_new: number }).total_new).toBe(0);

    board.roles = [
      ...board.roles,
      { ...board.roles[0]!, id: "greenhouse:coinbase:2", title: "Frontend Engineer", url: "https://x.example/2" },
    ];
    const found = await client.callTool({
      name: "check_new_roles",
      arguments: { watch_id },
    });
    const structured = found.structuredContent as {
      total_new: number;
      new_roles: Array<{ id: string }>;
    };
    expect(structured.total_new).toBe(1);
    expect(structured.new_roles[0]!.id).toBe("greenhouse:coinbase:2");
    const text = (found.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("Coinbase, Frontend Engineer, Remote - USA, https://x.example/2");

    const deleted = await client.callTool({ name: "delete_watch", arguments: { watch_id } });
    expect((deleted.structuredContent as { deleted: boolean }).deleted).toBe(true);

    const gone = await client.callTool({
      name: "check_new_roles",
      arguments: { watch_id },
    });
    expect(gone.isError).toBe(true);
    await client.close();
  });

  it("list_open_roles searches statelessly", async () => {
    const client = await connect("secret-token");
    const res = await client.callTool({
      name: "list_open_roles",
      arguments: { keywords: ["design engineer"] },
    });
    const structured = res.structuredContent as { total: number; roles: Array<{ title: string }> };
    expect(structured.total).toBe(1);
    expect(structured.roles[0]!.title).toBe("Design Engineer");
    await client.close();
  });
});
