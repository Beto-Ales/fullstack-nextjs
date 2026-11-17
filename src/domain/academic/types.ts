export const ISO_WEEK_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export type IsoWeekDay = (typeof ISO_WEEK_DAYS)[number];

