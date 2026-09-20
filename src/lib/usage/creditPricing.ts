// Single source of truth for what a duration costs. Change pricing here
// only - nowhere else in the codebase should hardcode credit numbers.
// Deliberately has no dependency on the database client so pricing logic
// can be unit tested without a live Postgres connection.
export const CREDIT_COSTS: Record<string, number> = {
  "30s": 5,
  "1m": 10,
  "3m": 25,
  "5m": 40,
  "10m": 75,
  custom: 100,
};

export function creditCostForDuration(duration: string): number {
  return CREDIT_COSTS[duration] ?? CREDIT_COSTS.custom ?? 100;
}
