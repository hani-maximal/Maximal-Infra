# Changelog

## 2026-06-26 — IaC staging environment: RDS, Redis, S3, Secrets Manager

Extended the existing OpenTofu stack (`infra/tofu/`) to provision a full staging data tier. All resources are gated by feature flags so the stack still boots cleanly with `enable_database = false` for lightweight deploys.

- **Isolated subnets** (offset +10): RDS and ElastiCache live in subnets with no internet route; task SG is the only allowed ingress source.
- **RDS PostgreSQL 16** (`db.t3.micro`): two instances — `maximal-ops` (`maximal_ops` DB) and `maximal-app` (`maximal_app` DB). Single-AZ, `skip_final_snapshot = true`, `deletion_protection = false` for staging.
- **ElastiCache Redis 7.1** (`cache.t3.micro`, single node) in the isolated subnets.
- **S3 contracts bucket** (`{name}-contracts-{account_id}`) with versioning enabled and all public access blocked.
- **Secrets Manager**: three secrets — `{name}/ops-db`, `{name}/app-db`, `{name}/app-config` (JWT secret + integration token placeholders). `recovery_window_in_days = 0` for fast teardown in staging.
- **Secret injection via ECS**: `task_secrets` local builds the `secrets = [...]` array with individual JSON field references (`arn:...:key::`) so ECS injects `DB_OPS_HOST`, `DB_OPS_USER`, `DB_OPS_PASSWORD`, `DB_APP_*`, and `JWT_SECRET` directly. Matches `resolveOpsUrl()` / `resolveAppUrl()` in `src/db/client.ts`.
- **IAM**: execution role gains `secretsmanager:GetSecretValue` on all three secrets; task role gains `s3:*` on contracts bucket and `secretsmanager:GetSecretValue` on app-config.
- **Task definition**: `environment` and `secrets` now use `local.task_environment` / `local.task_secrets`. `CONTRACTS_S3_BUCKET` and `REDIS_URL` env vars injected conditionally.
- **ECS service**: deployment percents flip from `0/100` to `100/200` when `enable_database = true` (rolling updates now safe).
- **variables.tf**: added `enable_database`, `enable_redis`, `enable_contracts_bucket`, `database_instance_class`, `redis_node_type`, `jwt_secret`; relaxed `desired_count` validation to allow 1–2; relaxed `maximal_mode` to allow `"observe"` or `"remediate"`.
- **outputs.tf**: added endpoints, secret ARNs, Redis endpoint, and contracts bucket name.
- **terraform.tfvars.example**: updated with all new variables and generation hint for `jwt_secret`.

## 2026-06-26 — Tier 1 item 1: unregistered actions unit-tested

All 6 implementable missing actions were already in `src/actions.ts` (added in the prior Tier-1 session). This session adds the unit test coverage required by TODO item 1.

- New `test/actions.test.ts`: 33 unit tests covering all 6 new actions via `MockAwsAdapter`:
  - `scale_ecs_service` — scale up, revert, missing-ECS precondition fail
  - `scale_ecs_service_down` — scale down, revert, scale-to-zero precondition guard
  - `restore_lambda_reserved_concurrency` — set concurrency, revert-to-null (delete), revert-to-prior
  - `scale_out_asg` — scale out, revert, not-greater-than-current guard, exceeds-max guard
  - `rollback_lightsail_container_deployment` — rollback to lastActive, revert, no-prior guard
  - `detach_from_lightsail_lb` — detach, revert (re-attach), call ordering verified
- `rollback_k8s_deployment` is intentionally absent — Kubernetes/EKS is out of scope per CLAUDE.md §17.
- Total: 44 tests (11 safety invariant + 33 action unit tests), all green.

## 2026-06-26 — Multi-tenancy M7, app DB, connector CRUD

Two Tier-2 TODO items implemented. All 11 safety invariant tests still pass; TypeScript strict check clean.

**TODO Item 6 — App database (users, tenants, connectors, subscriptions):**
- New `src/db/app-schema.ts`: `appTenants`, `users` (email unique, scrypt-hashed passwords), `connectors` (IAM role or access-key, per-tenant), `appTrustConfigs`. PostgreSQL via Drizzle.
- New `src/db/app-client.ts`: `getAppDb()` using `APP_DATABASE_URL` (separate from ops `DATABASE_URL`). SSL enforcement same as ops client.
- New `drizzle.app.config.ts`: separate drizzle-kit config for app DB. New `db:generate:app` / `db:migrate:app` scripts in `package.json`.
- `POST /api/auth/register`: creates `appTenants` + `users` row, returns JWT with `{ sub: userId, tenantId }`. Duplicate email → 409.
- `POST /api/auth/login`: queries app DB first (email/password with `crypto.scrypt` timing-safe verify), falls back to env-var credentials for single-tenant deploy.
- Connector CRUD: `GET /api/connectors`, `POST /api/connectors`, `DELETE /api/connectors/:id` (tenant-scoped), `PUT /api/connectors/:id/test` (AssumeRole → GetCallerIdentity via `@aws-sdk/client-sts`).
- `APP_DATABASE_URL` added to `.env.example`.

**TODO Item 7 — Multi-tenancy M7 (per-tenant orchestrators, JWT-resolved tenantId):**
- New `src/tenant.ts`: `TenantRegistry` — lazily creates and caches a full `TenantBundle` (orchestrator + ContractRegistry + IncidentRepository + AuditStore + ContextGraph) per tenantId. Default tenant pre-registered at startup for backward compat.
- `src/app.ts`: `request.tenantId` set by `onRequest` hook (default tenant) and overridden by `requireAuth` from JWT `tenantId` claim. `getBundle(tenantId)` helper used by all route handlers.
- All route handlers updated to use per-tenant bundle: `/api/incidents/*`, `/api/contracts`, `/api/subscription`, `/api/learning/*`, `/api/trust-configs`.
- Contract reload subscription now calls `tenantRegistry.reloadContracts(tenantId)` so each tenant's registry hot-reloads independently.
- Logout revocation key scoped to the JWT's `tenantId` claim rather than the env-var default.
- `tenants: tenantRegistry.tenantIds()` added to `/api/health` for observability.

## 2026-06-26 — GitHub PR action, DB write-through, S3 contract storage, proposal pipeline

Four Tier-1 TODO items implemented. All 11 safety invariant tests still pass; TypeScript strict check clean.

**TODO Item 2 — `open_fix_as_code_pr` (GitHub integration):**
- New `src/github.ts`: `GitHubAdapter` (real) and `NullGitHubAdapter` (test/dry-run). Supports `GITHUB_TOKEN` PAT or full GitHub App auth (`GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY` + `GITHUB_INSTALLATION_ID`). Uses Node 20 native `fetch`; no new runtime dependency.
- `open_fix_as_code_pr` registered in `ActionRegistry` when `GITHUB_TOKEN` / App creds are present. Uses Claude (if `ANTHROPIC_API_KEY` set) to draft a targeted config change, then creates a branch → commits → opens PR. Snapshot = current file content + SHA; revert = close the PR. `isReversible: true`.
- `createActionRegistry(adapter, github?)` — optional second argument; action is only registered when a GitHub adapter is passed.
- Unblocks the fallback path in 10+ contracts (`post_deploy_5xx_spike`, `lambda_error_spike`, `rds_connection_saturation`, `elasticache_memory_pressure_evictions`, `ecs_image_pull_failed`, `ecs_task_placement_capacity_failed`, `fargate_task_oom_kill`, `sqs_worker_backlog_saturation`, `ec2_disk_full`, `lambda_timeout_duration_spike`).

**TODO Item 4 — Orchestrator state externalization (write-through DB):**
- `IncidentRepository`: `setDb(db, tenantId)` enables eager DB upserts on every `create()` / `setState()`. `loadFromDb()` pre-populates the in-memory cache from active incidents on startup. `persistPlan(id, plan)` writes the plan JSON to the incident row's `plan` column. The in-memory `Map` stays as a fast-path cache; DB is the source of truth.
- `AuditStore`: `setDb(db, tenantId)` fires fire-and-forget DB inserts (`audit_records`) on every `append()`. `verifyChain()` and `replay()` still operate on the in-memory array (fast, synchronous). `#persistAndLearn` now skips re-writing audit records (uses `onConflictDoNothing` as a catch-up safety net).
- `Orchestrator.execute()`: snapshot written to `snapshots` table immediately after `captureState()` — before `EXECUTING` transition.
- `buildApp()` now calls `incidents.setDb()`, `audit.setDb()`, and `await incidents.loadFromDb()` when `DATABASE_URL` is set. No-op without a DB.

**TODO Item 6 — S3 contract storage:**
- `ContractRegistry.loadFromS3(tenantId)`: lists `defaults/` then `{tenantId}/` prefix; tenant overrides take priority. Falls back silently if `CONTRACTS_BUCKET` is unset. `reload(tenantId)` alias for hot-reload.
- New `@aws-sdk/client-s3` added to dependencies.
- `subscribeToContractReloads(handler)` in `src/events.ts`: Redis `PSUBSCRIBE mx:contracts:reload:*`; calls handler(tenantId) on message. `publishContractReload(tenantId)` publishes the signal.
- `buildApp()` subscribes on startup; all engine instances hot-reload their `ContractRegistry` when any instance triggers a reload.

**TODO Item 7 — Proposal → live contract pipeline:**
- `PATCH /api/learning/proposals/:id` extended: on `status: "approved"`:
  1. Fetches the proposal, validates `proposedYaml` against `ContractSchema` (returns 422 on invalid YAML).
  2. Writes validated YAML to `s3://CONTRACTS_BUCKET/{tenantId}/{incident_type}.yaml`.
  3. Publishes `mx:contracts:reload:{tenantId}` → all instances hot-reload within seconds.
  4. Falls back to in-memory hot-load when `CONTRACTS_BUCKET` is not set (dev mode).
- New env vars: `CONTRACTS_BUCKET`, `GITHUB_TOKEN`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`.

## 2026-06-26 — Six new remediation actions registered

Filled the largest gap in `ActionRegistry`: 5 incident types that previously escalated silently (no implemented action matched the contract) now have working execute + snapshot + revert paths. All 11 safety invariant tests still pass.

**New actions in `src/actions.ts`:**
- `scale_ecs_service` — ECS `UpdateService(desiredCount)` up; snapshot prior count; revert restores it. Unblocks: `sqs_worker_backlog_saturation`, `alb_latency_saturation`, `fargate_service_unhealthy`
- `scale_ecs_service_down` — same AWS call but reducing count; human-only gate (contract `always_human`, empty `allowed_action_types`). Unblocks: `rds_connection_saturation` APPROVE path
- `restore_lambda_reserved_concurrency` — Lambda `PutFunctionConcurrency`; snapshot existing value (null = unreserved); revert calls `DeleteFunctionConcurrency` if prior was null. Unblocks: `lambda_throttling_concurrency_exhausted`
- `scale_out_asg` — AutoScaling `SetDesiredCapacity`; precondition checks new > current and ≤ maxSize; revert scales back in. Unblocks: `ec2_asg_unhealthy_hosts`, `ecs_task_placement_capacity_failed`
- `rollback_lightsail_container_deployment` — finds last ACTIVE deployment via `GetContainerServiceDeployments`, redeploys via `CreateContainerServiceDeployment`; snapshot captures failing deployment for revert. Unblocks: `lightsail_container_deployment_failed`
- `detach_from_lightsail_lb` — `DetachInstancesFromLoadBalancer`; revert calls `AttachInstancesToLoadBalancer`. Unblocks: `lightsail_instance_unhealthy` auto path

**New AWS SDK packages:** `@aws-sdk/client-auto-scaling`, `@aws-sdk/client-lightsail`

**`AwsAdapterInterface`** extended with 10 new methods (ECS desired count, Lambda concurrency, ASG, Lightsail deployment + LB). `MockAwsAdapter` implements all of them with in-memory state for tests.

**`chooseAction` in `src/orchestrator.ts`** updated from prefix-matching to a `switch` on `incident.type`, with correct action/param selection for all new types.

**Not implemented:** `rollback_k8s_deployment` — EKS/Kubernetes is explicitly out of scope per `CLAUDE.md §out-of-scope`. `open_fix_as_code_pr` remains a separate TODO (GitHub integration, not an AWS SDK action).

---

## 2026-06-26 — Subscription tiers (enforced)

Replaced static marketing copy with real feature gates. Four tiers: **Starter** (Free), **Team** ($399), **Scale** ($999), **Enterprise** (Custom). Tier is stored in the DB (`tenants.subscription_tier`) and falls back to `MAXIMAL_SUBSCRIPTION_TIER` env var (defaults to `team` when unset).

**New: `src/subscription.ts`**
- `TIER_LIMITS` — canonical definition of what each tier allows: max services, allowed autonomy modes, Slack workflows, custom trust configs, audit export, allowed connectors, SSO, custom contracts
- `getTenantTier(tenantId)` — reads from DB with env var fallback; non-fatal on DB failure
- `tierAtLeast(current, required)` — tier ordering helper used in server gates
- `getLimits(tier)` — returns the `TierLimits` object for a given tier

**Schema — `tenants` table**
- New `subscription_tier` Postgres enum column (`starter | team | scale | enterprise`), defaults to `team`

**Enforcement in `src/app.ts`**
- `GET /api/subscription` — returns `{ tier, limits, usage: { serviceCount } }`; auth-gated
- `POST /api/incidents/demo` — Starter tenants blocked if adding a new service would exceed the 3-service cap (HTTP 402)
- `PUT /api/trust-configs` / `DELETE /api/trust-configs` — now require Scale tier or higher (HTTP 402 otherwise)
- Hardcoded `DEFAULT_TENANT_ID` strings consolidated to a single constant

**UI**
- Settings page: new **Plan** tab showing current tier badge, service usage bar with cap warning, and per-feature availability checklist with lock icons for gated features
- Connectors page: fetches subscription on mount; connectors not in `allowedConnectors` for the tenant's tier are shown dimmed with a lock badge and an upgrade CTA instead of the setup flow

**New env var:** `MAXIMAL_SUBSCRIPTION_TIER` (see `.env.example`)

---

## 2026-06-26 — Trust config & automation depth

Per-tenant, per-incident-type automation dial. Replaces the binary approve/auto contract flag with a three-level policy that each tenant controls independently.

**New: `src/trust.ts`**
- `getTrustConfig(tenantId, incidentType)` — reads from Postgres with a 5-minute in-memory TTL cache; falls back to `SUPERVISED` when no DB is configured
- `upsertTrustConfig` / `deleteTrustConfig` — transaction-based upsert handles nullable `incidentType` (NULL = tenant-wide default) without fighting Postgres NULL-unique semantics
- Cache invalidated on every write via `invalidateTrustCache()`

**Automation depth levels:**
- `SUPERVISED` (system default when unconfigured) — follow the contract's own approval setting; existing behaviour unchanged
- `CONSERVATIVE` — downgrade every `AUTO → APPROVE`; human always in the loop regardless of contract
- `AUTOMATED` — upgrade `APPROVE → AUTO` when `contract_requires_human` is the only blocker; system-mode gates (`observe_mode`, `global_approval_mode`) and safety `ESCALATE` decisions are never bypassed

**Orchestrator — `#applyTrustOverride()`**
- Applied after `evaluatePolicy()` before the plan is committed
- `ESCALATE` decisions are structurally inert to trust overrides (safety invariant)
- Audit record includes `automationDepth` and `trustOverrideApplied: boolean` on every `policy_decision` event
- Novel-incident escalation audit payload now includes `automationDepth` and `contractProposalQueued`

**Schema — `trust_configs` table**
- `automation_depth` Postgres enum (`CONSERVATIVE | SUPERVISED | AUTOMATED`)
- `novel_incident_confidence_threshold` — per-config floor for future novel-incident auto-routing
- `max_blast_radius_override` — optional tighter blast radius cap
- Two partial unique indexes: one per-type (`WHERE incident_type IS NOT NULL`), one per-tenant default (`WHERE incident_type IS NULL`)

**API — three new auth-gated endpoints:**
- `GET /api/trust-configs` — list all configs for the tenant
- `PUT /api/trust-configs` — upsert (body: `{ incidentType, automationDepth, ... }`, `incidentType: null` = tenant default)
- `DELETE /api/trust-configs` — remove a config by incident type or default

---

## 2026-06-26 — Learning pipeline

Domain-specific learning layer built on top of the incident audit trail. All infrastructure is opt-in via env vars and degrades gracefully when not configured.

**Infrastructure added:**
- **Postgres + Drizzle ORM** (`src/db/`) — 7 tables: `tenants`, `incidents`, `audit_records`, `snapshots`, `incident_outcomes`, `service_baselines`, `calibration_records`, `proposed_contract_updates`
- **Redis via ioredis** (`src/cache/`) — classifier response cache (by evidence fingerprint), JWT revocation sorted set, Redis-backed rate limiting (cluster-safe)
- **BullMQ** (`src/queue/`) — 3 queues: `outcome-writer`, `calibration`, `contract-learner`; all use `{ url }` connection options to avoid ioredis version conflicts

**Learning modules (`src/learning/`):**
- `rule-classifier.ts` — L1 deterministic rules for 9 incident types; no LLM, 0.95+ confidence only
- `classifier.ts` — 4-tier routing: L0 Redis cache → L1 rules → L2 Haiku → L3 Sonnet; Anthropic prompt caching on static system prompt; advisory only (can only lower confidence, never raise it)
- `rag.ts` — Postgres full-text search (`tsvector`) over `incident_outcomes.evidence_summary` for few-shot context
- `outcome-writer.ts` — idempotent worker: writes one `IncidentOutcome` row per terminal incident from the audit chain
- `calibration.ts` — buckets confidence scores against actual success rates; exposes `getCalibrationContext()` for the classifier prompt
- `contract-learner.ts` — Claude drafts proposed contract updates stored as `pending`; never auto-applied
- `workers.ts` — BullMQ worker process co-located with the API; returns async shutdown function

**Orchestrator changes:**
- `plan()` and `deny()` are now async
- Advisory classification in `plan()` — only lowers confidence, never raises
- `#persistAndLearn()` fires fire-and-forget on every terminal state: upserts incident + audit chain to Postgres, queues outcome-writer and (for `CLOSED`) contract-learner

**App changes:**
- Rate limiter uses Redis store when `REDIS_URL` is set
- JWT revocation on logout via Redis sorted set (`zadd` + `expire`)
- `requireAuth` checks revocation before admitting requests
- Three new learning endpoints: `GET /api/learning/calibration`, `GET /api/learning/proposals`, `PATCH /api/learning/proposals/:id`

**New env vars:** `DATABASE_URL`, `REDIS_URL`, `REDIS_TLS`, `ANTHROPIC_API_KEY`, `DEFAULT_TENANT_ID`

---

## 2026-06-26 — Next.js SaaS frontend

Rewrote the Vite+React frontend to Next.js 15 App Router + MUI v7. Architecture resolved as multi-tenant SaaS (central platform + connector model); on-prem is Enterprise tier.

**New pages:** landing (`/`), login, overview dashboard, incidents list + detail, contracts browser, connectors wizard (AWS / Slack / GitHub / PagerDuty / Datadog), settings (trust levels + team)

**Dev:** `pnpm dev` → Next.js on :3000. `pnpm dev:server` → Fastify engine on :4310. `next.config.ts` proxies engine API routes.

**New files:** `app/` (App Router), `components/`, `lib/theme.ts`, `lib/types.ts`, `lib/api.ts`, `middleware.ts`, `next.config.ts`, `tsconfig.server.json`

---

## 2026-06-25 — Security, UI, and accessibility pass

**Security:**
- JWT auth via `@fastify/jwt` — opt-in via `MAXIMAL_JWT_SECRET`; backward-compatible (tests pass without it)
- CORS via `@fastify/cors` — configurable via `MAXIMAL_ALLOWED_ORIGINS`
- Rate limiting via `@fastify/rate-limit` — 120 req/min per IP globally
- Tiered account lockout — 5 failures → 30-minute lock; repeat offence → 24-hour lock
- `actorId` derived from verified JWT server-side, not from client request body
- Timing-safe credential comparison on login
- CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` headers in production
- Error messages sanitized in `NODE_ENV=production`

**Frontend refactor:**
- `App.tsx` split from 830 lines to ~280 lines + dedicated component files
- Incident detail split into Evidence / Audit tabs
- Evidence cards collapsed by default, expand on click
- Confirmation dialog before Approve (shows action type, service, environment, scope)
- Outcome banner after execution (success / warning / error)
- Search and filter on incident queue and contracts grid
- Mobile navigation drawer
- Error toasts extended to 8s for errors; manual dismiss
- State persisted in `sessionStorage` (survives reload)
- `ErrorBoundary` wrapping entire app

**Accessibility:**
- `aria-label` on all icon-only buttons
- Secondary text colour raised to `#9aafa5` (7.6:1 contrast, WCAG AA)
- Audit timeline as semantic `<ol>/<li>`
- `aria-current="page"` on active nav items
- Skip-to-content link

---

## 2026-06-24 — Initial platform (M1–M5)

Core safe-execution control plane for AWS remediation.

**State machine:** `DETECTED → CLASSIFIED → CONTRACT_MATCHED → AWAITING_APPROVAL → EXECUTING → VERIFYING → RESOLVED → CLOSED` (with `ROLLING_BACK → ROLLED_BACK → ESCALATED` branches)

**Contract system:** 25 YAML contracts covering 23 incident types. Each contract defines: `min_confidence`, `allowed_actions`, `approval.mode`, `blast_radius`, `verify.checks`, `rollback_if_failed`. Invalid contract = hard boot failure.

**Policy engine (`evaluatePolicy`):** checks confidence floor, corroborating evidence kinds (≥2 independent sources), action allowlist, environment allowlist, blast radius, and action reversibility before any `AUTO` decision.

**Actions registered (4):**
- `restart_ec2_instance`
- `rollback_ecs_task_definition`
- `rollback_lambda_alias`
- `force_new_ecs_deployment`

**Audit store:** append-only, SHA-256 hash-chained, replay-verified. Every state transition, classification, snapshot, AWS call, verification, and rollback is recorded with actor and timestamp.

**Safety thresholds:**
- `MIN_CONTRACT_CONFIDENCE_FLOOR` = 0.90 — hard boot floor; no contract may go below this
- `DEFAULT_MIN_CONFIDENCE` = 0.95 — auto-action target; contracts inherit this if unset
- `MIN_CORROBORATING_EVIDENCE_KINDS` = 2 — a single metric crossing a threshold is not high confidence

**Detectors:** HTTP health probe (`src/detectors/http-health.ts`) — activates on `MAXIMAL_HEALTH_URL`; configures service context and fires incidents automatically

**Slack integration:** `@slack/bolt` Socket Mode — approval request with Approve / Deny buttons; outcome notification on CLOSED or ESCALATED

**API (Fastify):** `POST /api/incidents/demo`, `/plan`, `/approve`, `/deny`, `/simulate-verification-failure`; `GET /api/incidents`, `/api/incidents/:id/replay`, `/api/contracts`, `/api/health`

**Test suite:** 11 safety invariant tests covering confidence floor, corroborating-evidence gate, observe-mode lock, snapshot requirement, auto-revert on verification failure, audit chain integrity, and bounded-auto policy
