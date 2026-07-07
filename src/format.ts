import type { Role } from "./types.js";

export const MAX_ROLES = 25;

export function roleLine(role: Role): string {
  const where = role.location ?? (role.remote ? "Remote" : "Location n/a");
  return `${role.company}, ${role.title}, ${where}, ${role.url}`;
}

/**
 * Caps at MAX_ROLES and returns an SMS-friendly text block (one line per role)
 * plus the capped structured list.
 */
export function formatRoles(
  roles: Role[],
  header: string,
): { text: string; capped: Role[]; truncated: boolean } {
  const capped = roles.slice(0, MAX_ROLES);
  const truncated = roles.length > capped.length;
  const lines = [header, ...capped.map(roleLine)];
  if (truncated) {
    lines.push(`(showing ${capped.length} of ${roles.length} — list truncated)`);
  }
  return { text: lines.join("\n"), capped, truncated };
}
