# TODO

Last updated: 2026-06-27

---

## ✅ Done

- **All 8 missing actions** — `scale_ecs_service`, `scale_ecs_service_down`, `restore_lambda_reserved_concurrency`, `scale_out_asg`, `rollback_lightsail_container_deployment`, `detach_from_lightsail_lb`, `detach_unhealthy_target`, `extend_ebs_volume`, `set_asg_instance_unhealthy`, `rerun_failed_deployment`, `scale_node_group`, `reboot_lightsail_instance` — all registered in `createActionRegistry`
- **`open_fix_as_code_pr`** — registered; Claude drafts a minimal config patch, opens PR, `isReversible` closes it
- **`open_revert_pr`** — registered; Git Data API revert commit + PR for EC2/instance services; tip-only safety gate
- **Orchestrator state externalization** — `IncidentRepository` and `AuditStore` write through to Postgres on every mutation; in-memory maps are warm cache, DB is source of truth
- **Infrastructure / Terraform** — ECS Fargate, RDS (ops + app), ElastiCache Redis, S3 contracts bucket, ALB, IAM roles, Secrets Manager, ECR — all in `infra/tofu/`
- **Dockerfile** — three-stage Next.js + Fastify build; `start.sh` runs both processes; `output: 'standalone'`
- **S3 contract storage** — `ContractRegistry.loadFromS3(tenantId)`, Redis pub/sub hot-reload, per-tenant S3 prefix
- **Proposal → live contract pipeline** — `PATCH /api/learning/proposals/:id` validates YAML, writes to S3, publishes Redis reload; contract live within seconds
- **App database** — `app-schema.ts` (users, tenants, subscriptions, connectors), `app-client.ts`, wired into auth + connectors endpoints
- **Per-tenant AWS adapters** — `src/connector-adapter.ts` resolves IAM role connector → STS AssumeRole → scoped `AwsAdapter`; 55-min TTL cache; `TenantRegistry.evict()` called on connector mutation
- **Multi-tenancy (partial)** — `TenantRegistry` builds per-tenant bundles with isolated adapters and action registries; JWT carries `tenantId`; per-tenant S3 contracts and DB scoping

---

## Tier 1 — Before first design partner

---

### 1. ALB container port: 4310 → 3000

The Terraform task definition targets port `4310` (Fastify). Now that the container serves Next.js on `3000` as PID 1 (Fastify runs in background), the ALB never reaches the frontend — it hits the raw API server directly.

**Fix:** Change `container_port` default in `variables.tf` to `3000`, update the healthcheck in the ECS task definition to hit `/api/health` on `3000` (Next.js proxies it through), and update the ALB target group. Next.js `next.config.ts` rewrites handle all `/api/*` → Fastify internally.

**Files:** `infra/tofu/variables.tf` (default), `infra/tofu/main.tf` (healthcheck command port).

---

### 2. Tests for `open_revert_pr`

No test coverage for the new action. Three cases need covering:

- `preconditions` fails when `commitSha !== HEAD` (non-tip commit)
- `execute` constructs the correct revert commit (parent tree SHA as new tree, correct parent)
- `revert` calls `closePr` when `findPullRequestByBranch` returns a PR number, no-ops when it returns null

Use the `NullGitHubAdapter` for happy-path and a spy/override for failure cases. Follow the pattern in `test/actions.test.ts`.

---

### 3. DB migration workflow

Both Postgres databases (`maximal_ops`, `maximal_app`) need schema pushes before the container can start. Currently `drizzle-kit push` must be run manually — there's no migration step in the deploy pipeline.

**What to build:**
- `infra/scripts/migrate.sh` — runs `drizzle-kit push` against both DBs using the RDS credentials from Secrets Manager (same pattern as `seed-secrets.sh`)
- Or: add a one-off ECS task (run-task) to the deploy pipeline that runs migrations before the service update

---

## Tier 2 — Before general availability

---

### ✅ 4. One-shot approval path for novel incidents — DONE

`src/learning/novel-classifier.ts` + orchestrator novel path. When no contract matches and `automationDepth !== "CONSERVATIVE"`, Claude (opus-4-7) reasons over the evidence and proposes a typed action from the registered set. Proposal always requires human approval (no auto path). Synthetic conservative contract built on-the-fly, stored in `#novelContracts` map for `execute()` to find. CONSERVATIVE tenants still hard-escalate.

---

### 5. Multi-tenancy: remove DEFAULT_TENANT_ID fallback

`DEFAULT_TENANT_ID` is still used as a fallback across all endpoint handlers. In production every request must carry a valid JWT with a real `tenantId` — the fallback is a correctness hole for multi-tenant billing and data isolation.

**What to build:**
- Remove the `DEFAULT_TENANT_ID` fallback from request handlers; return 401 when tenantId is absent and auth is enabled
- Keep it only for local dev (auth disabled path)

---

### 6. Per-tenant GitHub installation IDs

Currently one global `GITHUB_INSTALLATION_ID` in Secrets Manager — all tenants share one GitHub App installation. A second tenant's repos are unreachable.

**What to build:**
- Add `githubInstallationId` (nullable) to the `connectors` table (or a dedicated `github_installations` table)
- UI: connectors page shows a "Connect GitHub" flow — user pastes their installation ID after installing the Maximal GitHub App on their org
- `connector-adapter.ts`: `resolveGitHubAdapterForTenant(tenantId, appDb)` — looks up installation ID, exchanges for per-installation token using the platform App private key
- `TenantRegistry.getOrCreate()`: resolve GitHub adapter per-tenant the same way AWS adapters are resolved now

---

## Tier 3 — Revenue / GTM

---

### 7. Stripe billing

No payment integration exists.

**What to build:**
- `POST /api/stripe/checkout` — creates Stripe Checkout Session for Team or Scale plan
- `POST /api/stripe/portal` — creates Stripe Customer Portal session
- `POST /api/stripe/webhook` — handles `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
- Env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_TEAM_MONTHLY`, `STRIPE_PRICE_SCALE_ANNUAL`

---

### 8. In-app upgrade paths

402 responses from the engine are swallowed silently. Settings > Plan has no way to change plan.

**What to build:**
- "Upgrade" / "Manage billing" buttons → Stripe Checkout / Portal
- Trial countdown banner when `trial_ends_at` is set
- 402 response → upgrade modal (feature name + which tier unlocks it + CTA)

**Depends on:** Stripe billing (item 7).

---

### 9. Landing page — finish implementation

Shell exists (`app/page.tsx`) but nav links are `#`, CTAs route to `/login`, footer links are stubs.

**What to build:**
- Nav: `/pricing`, `/docs` redirect, `/blog` stub
- CTAs: "Get started free" → waitlist form, "Start free trial" → Stripe Checkout
- Waitlist: `app/request-access/page.tsx` + `POST /api/waitlist` → Postgres or Loops/Resend
- Footer: `/privacy`, `/terms`, `/security` stubs; real GitHub + status page links
- SEO: `<title>`, `<meta description>`, OG image, `robots.txt`, `sitemap.xml`

---

### 10. BYOK — Enterprise self-hosting

Customers on Enterprise who self-host need to own every encryption boundary.

**What to build:**
- JWT secret rotation: `MAXIMAL_JWT_SECRET_PREVIOUS` for zero-downtime key rotation
- Audit log signing via KMS: `AUDIT_KMS_KEY_ARN` — each audit record signed with `kms:Sign`, verified on replay
- Connector credential envelope encryption: `CONNECTOR_KMS_KEY_ARN` — AES-256-GCM at rest in the connectors table
- S3 contract SSE-KMS: `CONTRACTS_BUCKET_KMS_KEY_ARN`
- `ANTHROPIC_API_KEY_SOURCE=env|secretsmanager` — key never appears in ECS task env vars when set to `secretsmanager`
- All BYOK paths fail hard at boot if IAM perms are missing

---

## Tier 4 — Pipeline optimization

---

### 11. Batch contract-learner Lambda

Replace per-incident BullMQ `contract-learner` job with a nightly EventBridge Lambda. One Sonnet call per incident type per batch vs. one call per incident — better proposals, lower cost.

**What to build:**
- Lambda handler: reads all `CLOSED` incidents since last run, groups by `incident_type`, calls Sonnet once per group
- EventBridge Cron: nightly
- Remove `contract-learner` from BullMQ (`outcome-writer` and `calibration` stay)

---

### 12. Calibration + baseline Lambdas

Move remaining scheduled workers out of BullMQ into EventBridge Cron Lambdas.

**What to build:**
- `calibration` Lambda — weekly; reads `incident_outcomes`, writes `calibration_records`
- `baseline-learn` Lambda — daily; computes rolling per-service metric statistics, writes `service_baselines`
