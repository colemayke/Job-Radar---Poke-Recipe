export type Provider = "greenhouse" | "lever" | "ashby" | "apple";

/** A company resolved to a specific ATS board. */
export interface CompanyRef {
  name: string;
  provider: Provider;
  token: string;
}

export interface Role {
  /** Stable, globally unique: `<provider>:<token>:<source job id>` */
  id: string;
  company: string;
  title: string;
  location: string | null;
  remote: boolean;
  department: string | null;
  url: string;
  /** ISO 8601 timestamp when known */
  posted_at: string | null;
  source: string;
}

export type WatchScope = "registry" | "custom";

export interface WatchConfig {
  /** "registry" scans every registered board; "custom" scans `companies`. */
  scope: WatchScope;
  /** Resolved boards for custom scope; empty for registry scope. */
  companies: CompanyRef[];
  /** Empty means no keyword filter: every role in scope is a candidate */
  keywords: string[];
  locations: string[];
  remote_only: boolean;
  /** Only roles posted within this many days are considered. */
  posted_within_days: number;
}

export interface FetchResult {
  roles: Role[];
  /** How many boards failed this round (network, schema, timeout). */
  failed_count: number;
  /** Up to a handful of failed company names, for reporting. */
  failed_sample: string[];
}
