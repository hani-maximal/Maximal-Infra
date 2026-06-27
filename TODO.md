# TODO

---

## Tier 1 — Before first design partner

These are blocking. Nothing real can run without them.

---

### 1. Unregistered actions

8 actions are referenced in contracts but missing from the `ActionRegistry`. Incidents that match these contracts currently silently ESCALATE instead of executing — a design partner would see unexplained escalations with no indication the system could have acted.

**Auto-eligible (in `allowed_action_types`) — contracts silently escalate today:**

| Action | Contracts unblocked | AWS call |
|---|---|---|
| `scale_ecs_service` | sqs_worker_backlog_saturation, alb_latency_saturation, fargate_service_unhealthy | ECS UpdateService (desired count) |
| `restore_lambda_reserved_concurrency` | lambda_throttling_concurrency_exhausted | Lambda PutFunctionConcurrency |
| `scale_out_asg` | ec2_asg_unhealthy_hosts, ecs_task_placement_capacity_failed | AutoScaling SetDesiredCapacity |
| `rollback_k8s_deployment` | eks_deployment_rollout_failed | EKS/k8s rollout undo |
| `rollback_lightsail_container_deployment` | lightsail_container_deployment_failed | Lightsail CreateContainerServiceDeployment (prior version) |
| `detach_from_lightsail_lb` | lightsail_instance_unhealthy | Lightsail DetachInstancesFromLoadBalancer |

**Human-only (in `allowed_actions`, not auto-eligible) — APPROVE paths broken today:**

| Action | Contract | AWS call |
|---|---|---|
| `scale_ecs_service_down` | rds_connection_saturation | ECS UpdateService (reduce desired count, snapshot prior) |

**Each action needs:** `parseParams`, `blastRadius`, `preconditions`, `captureState`, `execute`, `revert`, registered in `createActionRegistry`. Follow the pattern in `src/actions.ts`. Unit test with `aws-sdk-client-mock`.

---

### 2. `open_fix_as_code_pr` (GitHub integration)

Referenced as a fallback in 10+ contracts (post_deploy_5xx_spike, lambda_error_spike, lambda_timeout_duration_spike, rds_connection_saturation, elasticache_memory_pressure_evictions, ecs_image_pull_failed, ecs_task_placement_capacity_failed, fargate_task_oom_kill, sqs_worker_backlog_saturation, ec2_disk_full).

This is not an AWS action — it's a GitHub API integration. When a contract lists it as a fallback alongside a primary action, the intent is: "if the automated fix didn't fully resolve it, open a PR with the recommended config change so a human can merge the durable fix."

**What to build:**
- GitHub App or OAuth token connector (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`)
- `open_fix_as_code_pr` action: reads the incident type + audit trail, uses Claude to draft a specific config change (e.g. memory limit increase, pool size tweak, autoscaling rule), opens a PR on the tenant's infra repo
- Snapshot: current file content at the target path (revert = close the PR or revert the commit)
- `isReversible: true` — revert closes the PR
- Register in `ActionRegistry`

**Note:** The LLM drafts the PR content but a human merges it. No auto-merge path.

---

### 4. Orchestrator state externalization

Currently the orchestrator holds incidents, plans, snapshots, and audit records in memory. Single instance only, no zero-downtime deploys, incidents orphaned on crash.

**What to build:**
- Postgres as the primary store for live incident state (not just fire-and-forget persistence)
- `IncidentRepository` reads/writes from DB instead of a `Map`
- `AuditStore` writes synchronously to `audit_records` on every `append()`
- In-memory maps become a write-through cache with DB as source of truth
- Enables horizontal scaling and blue/green Fargate deploys without incident orphaning

---

### 5. Infrastructure / deployment

Nothing is deployed. Needed before any design partner connects a real AWS account.

**What to build:**
- Fargate service for the engine (`maximal-engine`) — always-on, private subnet
- RDS Postgres (two instances: `maximal-app`, `maximal-ops`)
- ElastiCache Redis
- S3 bucket for contracts (versioning + CloudTrail enabled)
- RDS Proxy (for Lambda → RDS connections)
- ALB with private target group for engine (not public-facing)
- IAM task roles scoped per service (engine: read S3 + read/write RDS; Lambda: read/write RDS + write S3)
- VPC: private subnets for engine + RDS + Redis; public subnet for ALB only

---

### 6. S3 contract storage

Replace YAML files in `contracts/` with S3-backed per-tenant storage. Blocks the proposal pipeline and multi-tenancy.

**What to build:**
- `ContractRegistry.loadFromS3(tenantId)` — lists tenant prefix, falls back to `defaults/` for any type not overridden, validates each YAML against `ContractSchema` at load time
- Bucket structure: `s3://maximal-contracts/defaults/{type}.yaml` and `s3://maximal-contracts/{tenantId}/{type}.yaml`
- Redis pub/sub reload: engine subscribes to `contracts:reload:{tenantId}`, re-fetches on message
- Seed new tenant prefixes from `defaults/` on first load

---

### 7. Proposal → live contract pipeline

Approved proposals currently flip a status flag and nothing else happens. This closes the loop.

**What to build:**
- On `PATCH /api/learning/proposals/:id` with `status: "approved"`:
  1. Parse and validate `proposedYaml` against `ContractSchema` — reject 422 if invalid
  2. Write validated YAML to `s3://maximal-contracts/{tenantId}/{incidentType}.yaml`
  3. Publish `contracts:reload:{tenantId}` to Redis
  4. Engine hot-reloads `ContractRegistry` for that tenant
- New contract live within seconds, no redeploy required

**Depends on:** S3 contract storage (item 6).

---

## Tier 2 — Before general availability

Core product gaps that need closing before charging real customers.

---

### 5. One-shot approval path for novel incidents

Currently SUPERVISED and AUTOMATED tenants hard-escalate when no contract exists. Coverage gap for patterns the system has never seen.

**What to build:**
- When no contract matches and `automationDepth !== "CONSERVATIVE"`:
  - Classifier proposes a bounded typed action
  - Stores a `novel_incident_proposal` (incident ID, proposed action, evidence summary)
  - Slack message with one-time Approve / Deny buttons
  - On approve: execute under the same safety invariants (snapshot + revert + audit)
  - Outcome feeds contract-learner to draft a formal contract
- `CONSERVATIVE` tenants: unchanged (hard escalate)

---

### 6. maximal-app database

The ops DB holds incidents and learning data. Users, sessions, subscriptions, and connectors need their own DB with different retention and encryption requirements.

**What to build:**
- `src/db/app-schema.ts` — tables: `users`, `sessions`, `tenants` (app-side), `subscriptions`, `connectors`, `trust_configs` (move from ops DB)
- `src/db/app-client.ts` — uses `APP_DATABASE_URL`
- Wire into Next.js auth, connectors, and settings routes
- `APP_DATABASE_URL` env var

---

### 7. Multi-tenancy (M7)

Tenant is currently resolved from `DEFAULT_TENANT_ID` env var. Must come from the authenticated session in production.

**What to build:**
- Tenant resolved from JWT `sub` → lookup in app DB → `tenantId` on every request
- Remove `DEFAULT_TENANT_ID` fallback from all endpoint handlers
- `ContractRegistry` per-tenant (S3 prefix per tenant)
- Orchestrator keyed by tenantId

**Depends on:** maximal-app DB (item 6), S3 contract storage (item 3).

---

## Tier 3 — Revenue / GTM

Needed before public launch and paid sign-ups.

---

### 8. Stripe billing

No payment integration exists.

**What to build:**
- `POST /api/stripe/checkout` — creates Stripe Checkout Session for Team or Scale plan
- `POST /api/stripe/portal` — creates Stripe Customer Portal session for billing management
- `POST /api/stripe/webhook` — handles `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
- Schema additions to `tenants`: `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `trial_ends_at`
- Env vars: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_TEAM_MONTHLY`, `STRIPE_PRICE_TEAM_ANNUAL`, `STRIPE_PRICE_SCALE_ANNUAL`

---

### 9. In-app upgrade paths

Settings > Plan tab shows tiers but has no way to change them. 402 responses from the engine are swallowed silently.

**What to build:**
- "Upgrade" / "Manage billing" buttons in Settings > Plan → Stripe Checkout / Portal
- Trial countdown banner when `trial_ends_at` is set
- Payment failed banner when `subscription_status === "past_due"`
- 402 response → upgrade modal (feature name + which tier unlocks it + CTA)
- Post-checkout success: verify session, refresh subscription, show toast

**Depends on:** Stripe billing (item 8).

---

### 10. Landing page — finish implementation

Shell exists (`app/page.tsx`) but nav links are `#`, CTAs route to `/login`, and footer links are stubs.

**What to build:**
- Nav: `/pricing` page, `/docs` redirect, `/blog` stub
- CTAs: "Get started free" → waitlist form, "Start free trial" → Stripe Checkout, "Talk to sales" → Calendly/mailto
- Waitlist: `app/request-access/page.tsx` + `POST /api/waitlist` route handler → Postgres or mailing list (Loops/Resend)
- Footer: `/privacy`, `/terms`, `/security` stubs; real GitHub + status page links
- SEO: `<title>`, `<meta description>`, OG image, Twitter card, `robots.txt`, `sitemap.xml`

---

### 11. Bring Your Own Key (BYOK) — Enterprise self-hosting

Customers on the Enterprise tier who self-host the control plane need to own every encryption boundary. Currently all secrets and sensitive fields are operator-managed with no customer-controlled key path.

**What to build:**

**JWT signing key rotation**
- `MAXIMAL_JWT_SECRET` already accepts any value; add a `MAXIMAL_JWT_SECRET_PREVIOUS` env var so the engine accepts tokens signed by either key during a grace window (dual-key verification). Enables zero-downtime secret rotation without forcing all users to re-login.

**Audit log signing via KMS (tamper-evident)**
- `AuditStore` currently SHA-256 hash-chains entries in memory. Add optional `AUDIT_KMS_KEY_ARN` — when set, each record's canonical hash is additionally signed with `kms:Sign` (RSASSA_PKCS1_V1_5_SHA_256) and the signature stored in the `auditRecords` table (`kmsSignature` column). `AuditStore.verifyChain()` calls `kms:Verify` for each signature. DB admin can no longer forge both the hash and the KMS signature simultaneously.
- Engine IAM role needs `kms:Sign` + `kms:Verify` on the customer CMK.

**Connector credential envelope encryption**
- `externalId` and `config` fields in the `connectors` table are stored in plaintext. When `CONNECTOR_KMS_KEY_ARN` is set, use `kms:GenerateDataKey` (AES-256-GCM envelope encryption) before writing to DB; decrypt on read. The DB holds only ciphertext + encrypted data key — a DB breach alone cannot recover credentials.

**BYOK for the LLM (Anthropic API key)**
- Self-hosters who do not want traffic routed through Maximal's Anthropic account set `ANTHROPIC_API_KEY` directly in their deployment. Add `ANTHROPIC_API_KEY_SOURCE=env|secretsmanager` — when `secretsmanager`, the engine calls `secretsmanager:GetSecretValue` at startup and caches; the raw key never appears in ECS task environment variables or CloudTrail.

**S3 contract bucket SSE-KMS**
- Require `ServerSideEncryption: "aws:kms"` + `SSEKMSKeyId` on all `PutObject` calls when `CONTRACTS_BUCKET_KMS_KEY_ARN` is set. Contracts at rest encrypted under the customer's CMK; Maximal's AWS account cannot read them.

**Enterprise gating**
- All BYOK configuration paths are validated at boot: if a KMS ARN is provided but the engine role lacks the required `kms:*` actions, boot fails with a clear error rather than silently falling back to unencrypted storage.
- Tier gate: BYOK features (KMS paths) require `enterprise` tier; engine logs a warning and falls back to plaintext on lower tiers rather than refusing to start.

**Ops**
- Self-hosting guide: IAM trust policies, KMS key policies, VPC requirements, minimum Fargate task role policy.
- Terraform module (optional): VPC + Fargate + RDS + ElastiCache + KMS CMKs + IAM roles wired together with correct least-privilege policies.

**New env vars:** `MAXIMAL_JWT_SECRET_PREVIOUS`, `AUDIT_KMS_KEY_ARN`, `CONNECTOR_KMS_KEY_ARN`, `ANTHROPIC_API_KEY_SOURCE`, `CONTRACTS_BUCKET_KMS_KEY_ARN`

---

## Tier 4 — Pipeline optimization

Quality improvements to the learning pipeline. System works without these; they make it cheaper and smarter.

---

### 11. Batch contract-learner Lambda

Replace the per-incident BullMQ `contract-learner` job with a nightly EventBridge-triggered Lambda.

**What to build:**
- Lambda handler: reads all `CLOSED` incidents since last run, groups by `incident_type`, calls Sonnet once per group
- EventBridge Cron: nightly (or configurable window)
- Remove `contract-learner` from BullMQ (`outcome-writer` and `calibration` stay)
- RDS Proxy required before deploying

**Why:** One Sonnet call per type per batch vs. one call per incident. Better proposals, lower cost.

---

### 12. Calibration + baseline Lambdas

Move remaining scheduled workers out of BullMQ into EventBridge Cron Lambdas.

**What to build:**
- `calibration` Lambda — weekly; reads `incident_outcomes`, writes `calibration_records`
- `baseline-learn` Lambda — daily; computes rolling per-service metric statistics, writes `service_baselines`
- Both use RDS Proxy
