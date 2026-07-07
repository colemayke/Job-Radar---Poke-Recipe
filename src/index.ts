import { fetchAllRoles } from "./adapters/index.js";
import { createApp } from "./app.js";
import { createPool, migrate, PgWatchStore } from "./db.js";
import { WatchService } from "./watches.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 3000);

const pool = createPool(DATABASE_URL);
await migrate(pool);
const service = new WatchService(new PgWatchStore(pool), fetchAllRoles);
const app = createApp(service, fetchAllRoles, process.env.MCP_AUTH_TOKEN);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`job-radar MCP server listening on :${PORT} (POST /mcp)`);
});
