import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const subscriptionTierEnum = pgEnum("subscription_tier", [
  "starter",
  "team",
  "scale",
  "enterprise",
]);

// Mirrors Stripe's subscription statuses.
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
]);

export const userRoleEnum = pgEnum("user_role", ["operator", "admin"]);

// ---------------------------------------------------------------------------
// app_tenants — user-facing identity and billing anchor.
// Separate from the ops-DB `tenants` table (which holds learning/incident
// data). App DB has higher PII classification and different retention rules.
// subscriptionTier is a denormalized fast-read column kept in sync with
// subscriptions.tier via application-layer upsert on Stripe webhook.
// ---------------------------------------------------------------------------
export const appTenants = pgTable("app_tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  subscriptionTier: subscriptionTierEnum("subscription_tier")
    .notNull()
    .default("team"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// subscriptions — one row per tenant; source of truth for billing state.
// Stripe fields are written by the webhook handler. tier is the canonical
// allowed-modes gate; appTenants.subscriptionTier is kept in sync with it.
// ---------------------------------------------------------------------------
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => appTenants.id, { onDelete: "cascade" }),
    tier: subscriptionTierEnum("tier").notNull().default("team"),
    status: subscriptionStatusEnum("status").notNull().default("active"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripePriceId: text("stripe_price_id"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantUnique: uniqueIndex("subscriptions_tenant_uidx").on(t.tenantId),
    stripeSubIdx: index("subscriptions_stripe_sub_idx").on(t.stripeSubscriptionId),
    stripeCustomerIdx: index("subscriptions_stripe_customer_idx").on(t.stripeCustomerId),
  })
);

// ---------------------------------------------------------------------------
// users — one row per human operator. Linked to one tenant.
// Passwords hashed with Node crypto.scrypt (64-byte key, 16-byte hex salt).
// ---------------------------------------------------------------------------
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("operator"),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => appTenants.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUnique: uniqueIndex("users_email_uidx").on(t.email),
    tenantIdx: index("users_tenant_idx").on(t.tenantId),
  })
);

// ---------------------------------------------------------------------------
// connectors — per-tenant AWS account connector configuration.
// Stores either an IAM Role ARN (cross-account assume-role) or a tag
// indicating access-key credentials are stored in Secrets Manager.
// config JSONB holds connector-type-specific metadata (never raw secrets).
// ---------------------------------------------------------------------------
export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => appTenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: varchar("type", { length: 20 }).notNull(), // "iam_role" | "access_key"
    roleArn: text("role_arn"),
    externalId: text("external_id"),
    region: varchar("region", { length: 30 }).notNull().default("us-east-1"),
    config: jsonb("config"),
    isActive: boolean("is_active").notNull().default(true),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("connectors_tenant_idx").on(t.tenantId),
  })
);

// ---------------------------------------------------------------------------
// app_trust_configs — mirrors the ops-DB trust_configs schema so it can be
// migrated here in the future. The ops-DB copy is still authoritative until
// that migration runs.
// ---------------------------------------------------------------------------
export const appTrustConfigs = pgTable(
  "app_trust_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => appTenants.id, { onDelete: "cascade" }),
    incidentType: varchar("incident_type", { length: 120 }),
    automationDepth: varchar("automation_depth", { length: 20 }).notNull().default("CONSERVATIVE"),
    novelIncidentConfidenceThreshold: text("novel_incident_confidence_threshold").notNull().default("0.950"),
    maxBlastRadiusOverride: text("max_blast_radius_override"),
    requiresApprovalOverride: boolean("requires_approval_override"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("app_trust_tenant_idx").on(t.tenantId),
  })
);
