import pg from "pg";
import type { WatchConfig } from "./types.js";

export interface WatchStore {
  createWatch(watchId: string, config: WatchConfig): Promise<void>;
  getWatch(watchId: string): Promise<WatchConfig | null>;
  updateWatch(watchId: string, config: WatchConfig): Promise<void>;
  deleteWatch(watchId: string): Promise<boolean>;
  /** Insert ids idempotently; returns only the ids newly inserted by THIS call. */
  markSeen(watchId: string, roleIds: string[]): Promise<string[]>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watches (
  watch_id   text PRIMARY KEY,
  config     jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS seen_roles (
  watch_id   text,
  role_id    text,
  first_seen timestamptz DEFAULT now(),
  PRIMARY KEY (watch_id, role_id)
);
`;

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 5 });
}

export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA);
}

export class PgWatchStore implements WatchStore {
  constructor(private pool: pg.Pool) {}

  async createWatch(watchId: string, config: WatchConfig): Promise<void> {
    await this.pool.query("INSERT INTO watches (watch_id, config) VALUES ($1, $2)", [
      watchId,
      JSON.stringify(config),
    ]);
  }

  async getWatch(watchId: string): Promise<WatchConfig | null> {
    const res = await this.pool.query<{ config: WatchConfig }>(
      "SELECT config FROM watches WHERE watch_id = $1",
      [watchId],
    );
    return res.rows[0]?.config ?? null;
  }

  async updateWatch(watchId: string, config: WatchConfig): Promise<void> {
    await this.pool.query("UPDATE watches SET config = $2 WHERE watch_id = $1", [
      watchId,
      JSON.stringify(config),
    ]);
  }

  async deleteWatch(watchId: string): Promise<boolean> {
    await this.pool.query("DELETE FROM seen_roles WHERE watch_id = $1", [watchId]);
    const res = await this.pool.query("DELETE FROM watches WHERE watch_id = $1", [watchId]);
    return (res.rowCount ?? 0) > 0;
  }

  async markSeen(watchId: string, roleIds: string[]): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const res = await this.pool.query<{ role_id: string }>(
      `INSERT INTO seen_roles (watch_id, role_id)
       SELECT $1, unnest($2::text[])
       ON CONFLICT DO NOTHING
       RETURNING role_id`,
      [watchId, roleIds],
    );
    return res.rows.map((r) => r.role_id);
  }
}
