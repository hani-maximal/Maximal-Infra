import { isNull, eq, and } from "drizzle-orm";
import { getDb } from "./db/client.js";
import { trustConfigs } from "./db/schema.js";
import type { TrustConfig } from "./types.js";

// SUPERVISED = pass-through: follow the contract's own approval setting.
// This is the right default when no trust config has been explicitly set —
// it preserves the existing behavior of every contract as written.
// Tenants must explicitly set CONSERVATIVE or AUTOMATED to change this.
const SYSTEM_DEFAULT: Omit<TrustConfig, "tenantId" | "incidentType"> = {
  automationDepth: "SUPERVISED",
  novelIncidentConfidenceThreshold: 0.95,
  maxBlastRadiusOverride: null,
  requiresApprovalOverride: null,
};

// In-memory TTL cache — trust configs change rarely, avoid a DB round-trip per plan().
// Invalidated on every PUT/DELETE via invalidateTrustCache().
const _cache = new Map<string, { config: TrustConfig; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getTrustConfig(
  tenantId: string,
  incidentType: string
): Promise<TrustConfig> {
  const cacheKey = `${tenantId}:${incidentType}`;
  const cached = _cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.config;

  const db = getDb();
  if (!db) return { tenantId, incidentType, ...SYSTEM_DEFAULT };

  const rows = await db
    .select()
    .from(trustConfigs)
    .where(eq(trustConfigs.tenantId, tenantId));

  const specific = rows.find((r) => r.incidentType === incidentType);
  const tenantDefault = rows.find((r) => r.incidentType === null);
  const row = specific ?? tenantDefault;

  const config: TrustConfig = {
    tenantId,
    incidentType,
    automationDepth:
      (row?.automationDepth as TrustConfig["automationDepth"]) ??
      SYSTEM_DEFAULT.automationDepth,
    novelIncidentConfidenceThreshold: row?.novelIncidentConfidenceThreshold
      ? parseFloat(row.novelIncidentConfidenceThreshold)
      : SYSTEM_DEFAULT.novelIncidentConfidenceThreshold,
    maxBlastRadiusOverride: row?.maxBlastRadiusOverride ?? null,
    requiresApprovalOverride: row?.requiresApprovalOverride ?? null,
  };

  _cache.set(cacheKey, { config, expiresAt: Date.now() + CACHE_TTL_MS });
  return config;
}

export function invalidateTrustCache(tenantId: string): void {
  for (const key of _cache.keys()) {
    if (key.startsWith(`${tenantId}:`)) _cache.delete(key);
  }
}

// Upsert a trust config row — handles NULL incidentType via select-then-insert/update
// to avoid partial unique index conflicts in Drizzle.
export async function upsertTrustConfig(
  tenantId: string,
  input: Omit<TrustConfig, "tenantId">
): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("Database not configured");

  const whereClause =
    input.incidentType === null
      ? and(eq(trustConfigs.tenantId, tenantId), isNull(trustConfigs.incidentType))
      : and(
          eq(trustConfigs.tenantId, tenantId),
          eq(trustConfigs.incidentType, input.incidentType)
        );

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: trustConfigs.id })
      .from(trustConfigs)
      .where(whereClause)
      .limit(1);

    const values = {
      automationDepth: input.automationDepth,
      novelIncidentConfidenceThreshold: String(input.novelIncidentConfidenceThreshold),
      maxBlastRadiusOverride: input.maxBlastRadiusOverride ?? null,
      requiresApprovalOverride: input.requiresApprovalOverride ?? null,
      updatedAt: new Date(),
    };

    if (existing.length > 0) {
      await tx
        .update(trustConfigs)
        .set(values)
        .where(eq(trustConfigs.id, existing[0]!.id));
    } else {
      await tx.insert(trustConfigs).values({
        tenantId,
        incidentType: input.incidentType,
        ...values,
      });
    }
  });

  invalidateTrustCache(tenantId);
}

export async function deleteTrustConfig(
  tenantId: string,
  incidentType: string | null
): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("Database not configured");

  const whereClause =
    incidentType === null
      ? and(eq(trustConfigs.tenantId, tenantId), isNull(trustConfigs.incidentType))
      : and(
          eq(trustConfigs.tenantId, tenantId),
          eq(trustConfigs.incidentType, incidentType)
        );

  await db.delete(trustConfigs).where(whereClause);
  invalidateTrustCache(tenantId);
}
