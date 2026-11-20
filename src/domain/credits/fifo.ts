export type FifoBucket = {
  grantMovementId: string;
  createdAt: Date;
  expiresAt: Date | null;
  availableUnits: number;
};

export function listAvailableFifoBuckets(buckets: FifoBucket[], referenceTime: Date): FifoBucket[] {
  return buckets
    .filter((bucket) => bucket.availableUnits > 0)
    .filter((bucket) => !bucket.expiresAt || bucket.expiresAt > referenceTime)
    .sort((a, b) => {
      const aExpiry = a.expiresAt ? a.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
      const bExpiry = b.expiresAt ? b.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
      if (aExpiry !== bExpiry) {
        return aExpiry - bExpiry;
      }
      const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
      if (byCreated !== 0) {
        return byCreated;
      }
      return a.grantMovementId.localeCompare(b.grantMovementId);
    });
}

export function pickNextFifoBucket(buckets: FifoBucket[], referenceTime: Date): FifoBucket | null {
  return listAvailableFifoBuckets(buckets, referenceTime)[0] ?? null;
}

