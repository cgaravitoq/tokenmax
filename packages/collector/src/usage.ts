export interface UsageDay {
  cache_create: number;
  cache_read: number;
  cost_usd: number;
  date: string;
  input: number;
  model: string;
  output: number;
  provider: string;
}

export interface UsageReport {
  days: UsageDay[];
  machine: string;
  providers?: string[];
  timezone?: string;
}
