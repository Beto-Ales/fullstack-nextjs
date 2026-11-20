import { DEFAULT_CLASS_CAPACITY } from "@/src/domain/academic/constants";

export const INITIAL_REGULATION = {
  cancellationNoticeDays: 7,
  monthlyCancellationCredits: 2,
  monthlyRecoveries: 2,
  creditExpirationMonths: 6,
  maxClassCapacity: DEFAULT_CLASS_CAPACITY,
};

export type RegulationRules = typeof INITIAL_REGULATION;
export type RegulationRule = keyof RegulationRules;
export type RegulationChanges = Partial<Record<RegulationRule, { previous: number | null; next: number }>>;

export const REGULATION_RULES = Object.keys(INITIAL_REGULATION) as RegulationRule[];
