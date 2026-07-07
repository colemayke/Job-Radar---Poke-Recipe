import type { WatchStore } from "../../src/db.js";
import type { WatchConfig } from "../../src/types.js";

export class MemoryStore implements WatchStore {
  watches = new Map<string, WatchConfig>();
  seen = new Map<string, Set<string>>();

  async createWatch(id: string, config: WatchConfig) {
    this.watches.set(id, config);
  }
  async getWatch(id: string) {
    return this.watches.get(id) ?? null;
  }
  async updateWatch(id: string, config: WatchConfig) {
    this.watches.set(id, config);
  }
  async deleteWatch(id: string) {
    this.seen.delete(id);
    return this.watches.delete(id);
  }
  async markSeen(id: string, roleIds: string[]) {
    const set = this.seen.get(id) ?? new Set<string>();
    this.seen.set(id, set);
    const inserted: string[] = [];
    for (const rid of roleIds) {
      if (!set.has(rid)) {
        set.add(rid);
        inserted.push(rid);
      }
    }
    return inserted;
  }
}
