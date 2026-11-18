import { describe, expect, it } from "vitest";

import { pickNextFifoBucket, type FifoBucket } from "@/src/domain/credits/fifo";

describe("pickNextFifoBucket", () => {
  const now = new Date("2026-02-01T10:00:00.000Z");

  it("picks bucket with nearest expiration first", () => {
    const buckets: FifoBucket[] = [
      {
        grantMovementId: "b",
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
        expiresAt: new Date("2026-06-01T10:00:00.000Z"),
        availableUnits: 1,
      },
      {
        grantMovementId: "a",
        createdAt: new Date("2026-01-01T09:00:00.000Z"),
        expiresAt: new Date("2026-04-01T10:00:00.000Z"),
        availableUnits: 1,
      },
    ];

    const picked = pickNextFifoBucket(buckets, now);
    expect(picked?.grantMovementId).toBe("a");
  });

  it("uses creation date tie-break when expiration is equal", () => {
    const buckets: FifoBucket[] = [
      {
        grantMovementId: "late-created",
        createdAt: new Date("2026-01-05T10:00:00.000Z"),
        expiresAt: new Date("2026-04-01T10:00:00.000Z"),
        availableUnits: 1,
      },
      {
        grantMovementId: "early-created",
        createdAt: new Date("2026-01-03T10:00:00.000Z"),
        expiresAt: new Date("2026-04-01T10:00:00.000Z"),
        availableUnits: 1,
      },
    ];

    const picked = pickNextFifoBucket(buckets, now);
    expect(picked?.grantMovementId).toBe("early-created");
  });

  it("uses stable id tie-break when expiration and creation date are equal", () => {
    const buckets: FifoBucket[] = [
      {
        grantMovementId: "b-id",
        createdAt: new Date("2026-01-03T10:00:00.000Z"),
        expiresAt: new Date("2026-04-01T10:00:00.000Z"),
        availableUnits: 1,
      },
      {
        grantMovementId: "a-id",
        createdAt: new Date("2026-01-03T10:00:00.000Z"),
        expiresAt: new Date("2026-04-01T10:00:00.000Z"),
        availableUnits: 1,
      },
    ];

    const picked = pickNextFifoBucket(buckets, now);
    expect(picked?.grantMovementId).toBe("a-id");
  });

  it("excludes expired buckets", () => {
    const buckets: FifoBucket[] = [
      {
        grantMovementId: "expired",
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
        expiresAt: new Date("2026-01-20T10:00:00.000Z"),
        availableUnits: 1,
      },
      {
        grantMovementId: "valid",
        createdAt: new Date("2026-01-02T10:00:00.000Z"),
        expiresAt: new Date("2026-02-20T10:00:00.000Z"),
        availableUnits: 1,
      },
    ];

    const picked = pickNextFifoBucket(buckets, now);
    expect(picked?.grantMovementId).toBe("valid");
  });
});

