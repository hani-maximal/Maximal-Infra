import { z } from "zod";
import { getDb } from "./db/client.js";
import { getAppDb } from "./db/app-client.js";
import { tenants } from "./db/schema.js";
import { subscriptions } from "./db/app-schema.js";
import { eq } from "drizzle-orm";
import type { AutonomyMode } from "./types.js";

export const SubscriptionTierSchema = z.enum(["starter", "team", "scale", "enterprise"]);
export type SubscriptionTier = z.infer<typeof SubscriptionTierSchema>;

export interface TierLimits {
  maxServices: number | null;
  allowedModes: string[];
  slackWorkflows: boolean;
  customTrustConfigs: boolean;
  auditExport: boolean;
  allowedConnectors: string[];
  sso: boolean;
  customContracts: boolean;
}

export const TIER_LIMITS: Record<SubscriptionTier, TierLimits> = {
  starter: {
    maxServices: 3,
    allowedModes: ["observe"],
    slackWorkflows: false,
    customTrustConfigs: false,
    auditExport: false,
    allowedConnectors: ["aws"],
    sso: false,
    customContracts: false,
  },
  team: {
    maxServices: null,
    allowedModes: ["observe", "approve", "bounded_auto"],
    slackWorkflows: true,
    customTrustConfigs: false,
    auditExport: true,
    allowedConnectors: ["aws", "slack", "github", "pagerduty"],
    sso: false,
    customContracts: false,
  },
  scale: {
    maxServices: null,
    allowedModes: ["observe", "approve", "bounded_auto"],
    slackWorkflows: true,
    customTrustConfigs: true,
    auditExport: true,
    allowedConnectors: ["aws", "slack", "github", "pagerduty", "datadog"],
    sso: false,
    customContracts: false,
  },
  enterprise: {
    maxServices: null,
    allowedModes: ["observe", "approve", "bounded_auto", "expanded_auto"],
    slackWorkflows: true,
    customTrustConfigs: true,
    auditExport: true,
    allowedConnectors: ["aws", "slack", "github", "pagerduty", "datadog"],
    sso: true,
    customContracts: true,
  },
};

const TIER_ORDER: SubscriptionTier[] = ["starter", "team", "scale", "enterprise"];

// Modes in ascending order of autonomy. expanded_auto is enterprise-only and
// not yet in AutonomyModeSchema — treated as bounded_auto ceiling for now.
const MODE_ORDER: AutonomyMode[] = ["observe", "approve", "bounded_auto"];

export function tierAtLeast(current: SubscriptionTier, required: SubscriptionTier): boolean {
  return TIER_ORDER.indexOf(current) >= TIER_ORDER.indexOf(required);
}

export function getLimits(tier: SubscriptionTier): TierLimits {
  return TIER_LIMITS[tier];
}

/**
 * Clamps mode down to the highest mode the tenant's tier permits.
 * Prevents a starter tenant from running in bounded_auto even if the
 * server-wide MAXIMAL_MODE env var is set to a higher value.
 */
export function clampModeToTier(mode: AutonomyMode, tier: SubscriptionTier): AutonomyMode {
  const allowed = TIER_LIMITS[tier].allowedModes;
  if (allowed.includes(mode)) return mode;
  for (let i = MODE_ORDER.indexOf(mode) - 1; i >= 0; i--) {
    const candidate = MODE_ORDER[i];
    if (candidate !== undefined && allowed.includes(candidate)) return candidate;
  }
  return "observe";
}

// Env var fallback — useful in local dev / single-tenant mode when no DB is configured.
// Defaults to "team" so the full feature set is available out of the box.
const ENV_TIER = SubscriptionTierSchema.safeParse(process.env.MAXIMAL_SUBSCRIPTION_TIER);
const DEFAULT_TIER: SubscriptionTier = ENV_TIER.success ? ENV_TIER.data : "team";

/**
 * Returns the active subscription tier for a tenant.
 * Priority: app DB subscriptions table → ops DB tenants table → env var default.
 */
export async function getTenantTier(tenantId: string): Promise<SubscriptionTier> {
  // App DB is the source of truth for billing/tier
  const appDb = getAppDb();
  if (appDb) {
    try {
      const rows = await appDb
        .select({ tier: subscriptions.tier })
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);
      const tier = SubscriptionTierSchema.safeParse(rows[0]?.tier);
      if (tier.success) return tier.data;
    } catch {
      // fall through
    }
  }

  // Ops DB fallback (single-tenant deployments without app DB)
  const db = getDb();
  if (db) {
    try {
      const rows = await db
        .select({ subscriptionTier: tenants.subscriptionTier })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const tier = SubscriptionTierSchema.safeParse(rows[0]?.subscriptionTier);
      if (tier.success) return tier.data;
    } catch {
      // fall through
    }
  }

  return DEFAULT_TIER;
}
