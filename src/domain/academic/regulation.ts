import { DEFAULT_CLASS_CAPACITY } from "@/src/domain/academic/constants";

export const INITIAL_REGULATION = {
  cancellationNoticeDays: 7,
  monthlyCancellationCredits: 2,
  monthlyRecoveries: 2,
  creditExpirationMonths: 6,
  maxClassCapacity: DEFAULT_CLASS_CAPACITY,
};

export const INITIAL_CONSECUTIVE_CANCELLATIONS_LIMIT = 3;

export type RegulationRules = typeof INITIAL_REGULATION & { maxEligibleConsecutiveCancellations: number | null };
export type RegulationRule = keyof RegulationRules;
export type RegulationChanges = Partial<Record<RegulationRule, { previous: number | null; next: number }>>;

export const REGULATION_RULES: RegulationRule[] = [
  ...(Object.keys(INITIAL_REGULATION) as (keyof typeof INITIAL_REGULATION)[]),
  "maxEligibleConsecutiveCancellations",
];
