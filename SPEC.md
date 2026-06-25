# Maximal MVP — Build Spec

> **Audience:** a coding agent (Claude Code / Codex) building the first version from scratch.
> **What this is:** a buildable spec for the *safe-execution control plane* — the trusted layer that turns an incident diagnosis into a **typed, bounded, verified, reversible** AWS remediation, with a complete audit trail.
> **What this is NOT:** an autonomous agent with open-ended production access. Read §3 (Non-goals) and §11 (Safety invariants) before writing any code that touches AWS.

---

## 1. Goal

Build a service that:

1. **Ingests** a diagnosis (from AWS DevOps Agent / Datadog over MCP, or from its own detector) for one of four AWS failure patterns.
2. **Classifies** it into a typed incident with a confidence score and cited evidence.
3. **Matches** it to a pre-approved **remediation contract** (YAML) that declares allowed actions, approval policy, blast-radius limits, verification criteria, and rollback conditions.
4. **Executes** a *single bounded* AWS action through scoped IAM — only if policy, confidence, blast radius, and reversibility all pass; otherwise it asks a human in Slack or escalates.
5. **Verifies** recovery against objective metrics, and **auto-rolls-back + escalates** if recovery is not confirmed in the verification window.
6. **Records** every signal, decision, tool call, AWS action, approval, and verification result to an append-only, replayable audit store, and posts the timeline to Slack.

The differentiator is **not** diagnosis quality — it is that every production write is safe, provable, and reversible.

### Definition of done (MVP)
A design partner can connect a non-production AWS account, run the four detectors in shadow mode, approve a rollback in Slack, watch it execute + verify + (on induced failure) auto-revert, and replay the full incident from the audit log — with **zero unsafe writes** across the synthetic test suite.

---

## 2. In scope (MVP)

| Area | MVP |
|---|---|
| Runtimes | AWS **ECS/Fargate** and **Lambda** (write); EC2/Lightsail read-only |
| Telemetry / change | CloudWatch logs, metrics, alarms; CloudTrail; ALB (ELBv2) health/error metrics |
| Diagnosis intake | MCP **client** ingesting AWS DevOps Agent / CloudWatch Investigations + Datadog; webhook intake for PagerDuty; plus an **own detector** for the four incident types |
| Deploy source | GitHub Actions (and AWS CodeDeploy) for deploy correlation |
| Human interface | Slack (evidence, confidence, approve/deny, timeline) |
| Incident types | (a) post-deploy 5xx spike on ALB-backed service, (b) ECS service unhealthy / crash-looping, (c) Lambda error spike after new version/alias shift, (d) failed/stuck deployment |
| Remediation actions | rollback ECS task def · rollback Lambda alias · force new ECS deployment · re-run failed deployment (approval) · open fix-as-code PR · escalate |
| Autonomy | Levels 0–1 by default; Level-2 (bounded auto) only for **reversible** actions inside blast radius, opt-in per contract |

## 3. Out of scope / NON-GOALS (hard guardrails)

The agent **must not** implement any of the following in the MVP. These are not "nice to skip" — they are safety boundaries:

- ❌ **No arbitrary shell / `eval` / generic "run command" action.** Every action is a typed, named, code-defined function. There is no path from text → shell.
- ❌ **No database repair, schema changes, or data migrations** as actions.
- ❌ **No secret rotation/changes, no destructive cache operations.**
- ❌ **No LLM-authored AWS parameters.** LLM output may *inform classification*; it may **never** select an action outside the contract allowlist or supply raw parameters to an AWS SDK call without zod validation.
- ❌ **No Build Mode** (golden-path provisioning) — later phase.
- ❌ **No Kubernetes/EKS** — fast-follow, not MVP.
- ❌ **No action without a revert path and a pre-action state snapshot.**

If a requirement seems to need one of these, **stop and surface it as an open question** (§17) rather than implementing it.

---

## 4. Architecture

Pipeline (one incident flows left → right; any stage can route to `ESCALATED`):

```
 diagnosis intake → classifier → context graph → contract engine
        │ (MCP client / detector / webhook)        │ (match + policy + blast radius)
        ▼                                          ▼
   typed Incident                          policy decision: AUTO | APPROVE | ESCALATE
                                                   │
                                                   ▼
                                  Slack approval gate (if required)
                                                   │
                                                   ▼
                       executor (snapshot → typed AWS action via scoped IAM)
                                                   │
                                                   ▼
                              verifier (objective health checks, windowed)
                                          │                    │
                                    verified                fail/timeout
                                          ▼                    ▼
                                    RESOLVED          auto-rollback → ESCALATED
                                          │
                                          ▼
                         learning loop (reusable contract + postmortem draft)

every transition → append-only, hash-chained audit store → Slack timeline
```

Components: **diagnosis intake**, **classifier**, **service context graph**, **contract engine**, **executor**, **verifier + auto-rollback**, **learning loop**, **Slack command center**, **audit store**, **MCP server/client**, **incident state machine** (orchestrator).

---

## 5. Tech stack & repo layout

**Decisive choices** (architecture is language-agnostic, but build it this way unless told otherwise). TypeScript is chosen specifically because *typed actions* is a core safety property and AWS SDK v3 gives first-class typed clients.

- **Language/runtime:** TypeScript (strict), Node.js 20+.
- **Validation:** `zod` everywhere (contracts, diagnoses, action params, config). This is load-bearing for safety, not optional.
- **AWS:** AWS SDK v3 — `@aws-sdk/client-ecs`, `client-lambda`, `client-cloudwatch`, `client-cloudwatch-logs`, `client-elastic-load-balancing-v2`, `client-cloudtrail`, `client-sts`.
- **LLM reasoning:** `@anthropic-ai/sdk` (classification + evidence summarization + postmortem drafting only).
- **MCP:** `@modelcontextprotocol/sdk` (server + client).
- **Slack:** `@slack/bolt` (Block Kit, interactivity).
- **HTTP (webhooks):** `fastify`.
- **Persistence:** Postgres via `drizzle-orm`. Audit table is **insert-only** with hash chaining.
- **Jobs/state:** start single-process with a durable `incidents` table + a tick loop; `bullmq` (Redis) optional behind an interface.
- **Tests:** `vitest`; `aws-sdk-client-mock` for unit tests; a synthetic-failure harness for integration.

```
maximal/
  CLAUDE.md                      # agent operating guide + guardrails (read first)
  SPEC.md                        # this file
  package.json  tsconfig.json
  drizzle/                       # migrations
  contracts/
    post_deploy_5xx_spike.yaml   # sample provided
  src/
    config/            # zod-validated env + account/role config
    types/             # zod schemas + inferred TS types (§6)
    intake/
      mcp-client.ts    # ingest diagnoses from upstream agents
      detectors/       # one file per incident type (§9.2)
      normalizer.ts    # upstream/own signal -> typed Incident
      confidence.ts    # re-score confidence against own evidence
    context/graph.ts   # service -> resources/owners/deps/allowed actions
    classifier/        # LLM-assisted incident typing (advisory only)
    contracts/         # loader, matcher, policy eval, blast-radius
    executor/
      action.ts        # RemediationAction interface (§9.6)
      actions/         # ecs-rollback.ts, lambda-rollback.ts, ecs-force-deploy.ts, rerun-deploy.ts, fix-pr.ts
      iam.ts           # STS assume-role per service/env
    verifier/          # windowed verification + auto-rollback
    learning/          # reusable contract synth + postmortem draft
    slack/             # bolt app, blocks, approval handlers, timeline
    audit/             # append-only store, hash chain, replay
    mcp/server.ts      # expose execute_remediation etc.
    statemachine/      # incident lifecycle orchestrator
    api/               # pagerduty/github webhooks
  test/
    unit/
    synthetic/         # failure harness + unsafe-write gate
```

---

## 6. Data models (zod is the source of truth)

```ts
// types/incident.ts
export const IncidentType = z.enum([
  "post_deploy_5xx_spike",
  "ecs_service_unhealthy",
  "lambda_error_spike",
  "deploy_failed_or_stuck",
]);

export const Evidence = z.object({
  kind: z.enum(["metric", "log", "deploy_event", "cloudtrail", "alarm"]),
  ref: z.string(),                 // ARN / log group / metric id / event id
  summary: z.string(),
  value: z.number().optional(),
  observedAt: z.string().datetime(),
});

export const Incident = z.object({
  id: z.string().uuid(),
  type: IncidentType,
  service: z.string(),             // logical service name (maps via context graph)
  environment: z.string(),
  source: z.enum(["aws_devops_agent", "datadog", "pagerduty", "self_detect"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(Evidence).min(1),
  deployCorrelation: z.object({
    deployId: z.string(),
    deployedAt: z.string().datetime(),
    artifactRef: z.string(),       // task def ARN / lambda version / sha
  }).nullable(),
  state: z.enum([
    "DETECTED","CLASSIFIED","CONTRACT_MATCHED","AWAITING_APPROVAL",
    "EXECUTING","VERIFYING","RESOLVED","ROLLING_BACK","ROLLED_BACK",
    "ESCALATED","CLOSED",
  ]),
  createdAt: z.string().datetime(),
});
```

```ts
// types/contract.ts  (parsed from YAML; see §7)
export const BlastRadius = z.object({
  maxAffectedServices: z.number().int().positive(),
  environments: z.array(z.string()),
  allowedActionTypes: z.array(z.string()),
  requireReversible: z.boolean().default(true),
});

export const RemediationContract = z.object({
  incidentType: IncidentType,
  source: z.array(z.enum(["aws_devops_agent","datadog","pagerduty","self_detect"])),
  detect: z.record(z.any()),       // detector params (typed per detector, §9.2)
  minConfidence: z.number().min(0).max(1).default(0.8),
  allowedActions: z.array(z.string()).min(1),
  approval: z.object({
    mode: z.enum(["always_human","auto_under_blast_radius"]),
    blastRadius: BlastRadius,
  }),
  verify: z.object({
    window: z.string(),            // e.g. "10m"
    checks: z.array(z.object({ metric: z.string(), condition: z.string() })),
  }),
  rollbackIfFailed: z.boolean().default(true),
  onResolve: z.object({
    draftPostmortem: z.boolean().default(true),
    learnContract: z.boolean().default(true),
  }),
  notify: z.object({ slackChannel: z.string() }),
});
```

```ts
// types/action.ts
export const ActionResult = z.object({
  ok: z.boolean(),
  actionType: z.string(),
  awsCalls: z.array(z.object({ api: z.string(), input: z.any(), at: z.string().datetime() })),
  snapshotId: z.string(),          // pointer to pre-action state for revert
  message: z.string(),
});

// types/audit.ts — append-only, hash-chained
export const AuditRecord = z.object({
  id: z.string().uuid(),
  incidentId: z.string().uuid(),
  ts: z.string().datetime(),
  actor: z.enum(["system","human"]),
  actorId: z.string().nullable(),  // slack user id if human
  eventType: z.enum([
    "signal","hypothesis","classification","contract_match","policy_decision",
    "approval_request","approval_granted","approval_denied","snapshot",
    "aws_action","verification","rollback","escalation","postmortem","state_change",
  ]),
  payload: z.any(),
  prevHash: z.string(),
  hash: z.string(),                // sha256(prevHash + canonical(payload) + ts)
});
```

---

## 7. Remediation contract (YAML)

The contract is the unit of trust. A sample lives at `contracts/post_deploy_5xx_spike.yaml` (also reproduced here). The loader validates it against `RemediationContract` (§6) at startup; an invalid contract is a hard boot failure.

```yaml
incident_type: post_deploy_5xx_spike
source: [aws_devops_agent, datadog, self_detect]
detect:
  service: auth-api
  signal:
    alb_5xx_rate: ">2% for 5m"
    deploy_window: "within 30m"
min_confidence: 0.80                 # below this -> escalate, never act
allowed_actions:
  - rollback_ecs_task_definition
  - disable_feature_flag
  - scale_previous_stable_service
approval:
  mode: auto_under_blast_radius
  blast_radius:
    max_affected_services: 1
    environments: [staging, production]
    allowed_action_types: [rollback_ecs_task_definition]
    require_reversible: true
verify:
  window: 10m
  checks:
    - { metric: alb_5xx_rate, condition: "<0.5% for 10m" }
    - { metric: p95_latency,  condition: "<500ms" }
rollback_if_failed: true
on_resolve:
  draft_postmortem: true
  learn_contract: true
notify:
  slack_channel: "#prod-incidents"
```

---

## 8. Incident lifecycle (state machine)

The orchestrator (`statemachine/`) advances one incident at a time and writes a `state_change` audit record on every transition.

| From | Event | To |
|---|---|---|
| `DETECTED` | classified, confidence computed | `CLASSIFIED` |
| `CLASSIFIED` | `confidence < minConfidence` | `ESCALATED` |
| `CLASSIFIED` | contract matched | `CONTRACT_MATCHED` |
| `CONTRACT_MATCHED` | policy = `always_human` **or** blast radius exceeded **or** not reversible | `AWAITING_APPROVAL` |
| `CONTRACT_MATCHED` | policy = `auto_under_blast_radius` **and** within limits **and** reversible | `EXECUTING` |
| `AWAITING_APPROVAL` | approved in Slack | `EXECUTING` |
| `AWAITING_APPROVAL` | denied / timeout | `ESCALATED` |
| `EXECUTING` | action ok | `VERIFYING` |
| `EXECUTING` | action error | `ROLLING_BACK` |
| `VERIFYING` | checks pass in window | `RESOLVED` |
| `VERIFYING` | fail / window timeout | `ROLLING_BACK` |
| `ROLLING_BACK` | revert ok | `ROLLED_BACK` → `ESCALATED` |
| `ROLLING_BACK` | revert fails | `ESCALATED` (page urgently) |
| `RESOLVED` | postmortem + learn | `CLOSED` |

Invariant: **no transition into `EXECUTING` is permitted unless** the policy check, confidence check, blast-radius check, reversibility check, and (if required) human approval have all passed and been audited.

---

## 9. Component specs

### 9.1 Diagnosis intake
- **MCP client** (`intake/mcp-client.ts`): connect to upstream agent MCP servers; map their RCA output → `Incident` via `normalizer.ts`. Upstream confidence is advisory; **re-score** with `confidence.ts` against our own evidence pulled from CloudWatch/CloudTrail.
- **Webhook intake** (`api/`): PagerDuty + GitHub deploy events (HMAC-verified).
- **Own detectors** (§9.2): for teams with no upstream AI SRE.

### 9.2 Detectors (own detection, read-only)
One module per type. Each returns `Incident | null`. Concrete logic:

- **post_deploy_5xx_spike** — ELBv2 via CloudWatch `GetMetricData`: `HTTPCode_Target_5XX_Count / RequestCount` over 5 min > threshold; correlate a deploy within `deploy_window` via CloudTrail `LookupEvents` (ECS `UpdateService` / Lambda `UpdateAlias`) or GitHub deploy event.
- **ecs_service_unhealthy** — ECS `DescribeServices`: `runningCount < desiredCount`, or recent stopped tasks with non-zero exit codes / failed health checks; crash-loop = N restarts in window.
- **lambda_error_spike** — Lambda `Errors` metric spike vs trailing baseline after a `PublishVersion`/`UpdateAlias` event.
- **deploy_failed_or_stuck** — ECS deployment `rolloutState == FAILED`, or `IN_PROGRESS` beyond `deployTimeout`; CodeDeploy deployment status `Failed`/`Stopped`.

Detector params come from the contract's `detect` block and are validated per-detector with zod.

### 9.3 Service context graph (`context/graph.ts`)
Maps a logical `service` → AWS resources (cluster/service/function ARNs), owners (for escalation), dependencies (for blast-radius/dependency impact), alarms, recent deploys, and the **allowed actions** for that service. Built from tags + config; cached, refreshed on a timer. Required before any action (supplies the snapshot targets and blast-radius dependency set).

### 9.4 Classifier (`classifier/`)
LLM-assisted typing + evidence summary. **Advisory only** — its output is a hypothesis with confidence, never an action selector. Output must conform to a zod schema; free-text is summarized, not executed.

### 9.5 Contract engine (`contracts/`)
`load()` (validate YAML), `match(incident)` → contract, `evaluatePolicy(incident, contract, context)` → `{ decision: "AUTO"|"APPROVE"|"ESCALATE", reasons[] }`. Computes blast radius from the context graph and compares against the contract. Pure functions, unit-tested exhaustively (this is where unsafe writes are prevented).

### 9.6 Executor + typed action interface (`executor/`)
**Every action implements this interface. There is no other way to touch AWS.**

```ts
export interface RemediationAction<P> {
  readonly type: string;
  readonly paramsSchema: ZodSchema<P>;
  readonly isReversible: boolean;
  blastRadius(p: P, ctx: Context): BlastRadius;
  preconditions(p: P, ctx: Context): Promise<{ ok: boolean; reason?: string }>;
  captureState(p: P, ctx: Context): Promise<Snapshot>;   // BEFORE execute
  execute(p: P, ctx: Context): Promise<ActionResult>;    // scoped IAM (STS)
  revert(snapshot: Snapshot, ctx: Context): Promise<ActionResult>;
}
```

MVP actions and their AWS calls:

| Action | Reversible | AWS calls (SDK v3) | Snapshot |
|---|---|---|---|
| `rollback_ecs_task_definition` | yes | find previous stable revision (`ListTaskDefinitions`/`DescribeServices` deployment history) → `UpdateService({ taskDefinition: prevStable, forceNewDeployment: true })` | current `taskDefinition` ARN |
| `rollback_lambda_alias` | yes | `GetAlias` → previous known-good version (from version history / last-good tag) → `UpdateAlias({ FunctionVersion: prevStable })` | current `FunctionVersion` |
| `force_new_ecs_deployment` | partial | `UpdateService({ forceNewDeployment: true })` | service deployment id |
| `rerun_failed_deployment` (approval only) | n/a | GitHub `workflow_dispatch` re-run **or** CodeDeploy `CreateDeployment` | deploy id |
| `open_fix_as_code_pr` | n/a (no prod write) | GitHub: create branch + commit config/IaC diff + open PR | — |

`iam.ts` assumes a **per-service/per-environment scoped write role** via STS for `execute`/`revert`; all reads use a separate read-only role.

### 9.7 Verifier + auto-rollback (`verifier/`)
Poll the contract's `verify.checks` over `verify.window`. On all-pass → `RESOLVED`. On fail/timeout → `revert(snapshot)` (if `rollbackIfFailed` and `isReversible`) then `ESCALATED`. Verification result (per check, with values) is audited.

### 9.8 Slack command center (`slack/`)
- Incident message (Block Kit): evidence summary + confidence + proposed action + computed blast radius + **Approve / Deny** buttons (only when `AWAITING_APPROVAL`).
- Threaded **timeline** updated on every state change; a final **verified-recovery** or **escalation** message.
- Approvals carry the Slack user id into the audit record (`approval_granted`/`approval_denied`).

### 9.9 Audit store (`audit/`)
Append-only Postgres table; each row's `hash = sha256(prevHash + canonicalJSON(payload) + ts)`. `append()` and `verifyChain()` and `replay(incidentId)` (reconstruct the full incident timeline). Nothing in the system mutates or deletes audit rows.

### 9.10 Learning loop (`learning/`)
On `RESOLVED`: draft a postmortem (LLM, from the audited timeline) and synthesize/strengthen a reusable contract (e.g. tighten `minConfidence`, record which action verified). Output is a *proposed* contract for human review, never auto-applied to autonomy gating without sign-off.

### 9.11 MCP server (`mcp/server.ts`)
Expose tools so upstream agents can hand Maximal a fix to execute **safely**:
- `maximal.execute_remediation({ diagnosis | incidentId, dryRun })` — runs the full safe pipeline (respects contracts/approval/verify).
- `maximal.get_contract({ incidentType })`, `maximal.list_incidents()`, `maximal.replay({ incidentId })`.
`dryRun` returns the policy decision + planned action + blast radius **without executing** — use it everywhere in tests.

---

## 10. Safety invariants (enforced in code + tested)

These are assertions the build must guarantee. Each maps to a test in `test/synthetic/unsafe-write.test.ts`:

1. No `execute()` runs if `incident.confidence < contract.minConfidence`.
2. No `execute()` runs if computed blast radius exceeds the contract.
3. No autonomous `execute()` runs if `action.isReversible === false` (requires human approval).
4. No `execute()` runs without a successful `captureState()` snapshot persisted first.
5. No action type runs unless it is in both `contract.allowedActions` and the service's allowed actions.
6. LLM/classifier output can never select an action or supply AWS params directly — only zod-validated, contract-allowlisted actions execute.
7. Every `execute()` has a corresponding tested `revert()`.
8. All inbound text (logs, tickets, upstream RCA) is treated as untrusted data (prompt-injection isolation): it is summarized/classified, never interpolated into a tool call or used to widen scope.
9. Default autonomy is **Level 1 (approve)** unless a contract explicitly opts into `auto_under_blast_radius`.

## 11. Autonomy levels

| Level | Behaviour |
|---|---|
| 0 Observe | Detect + recommend; no writes |
| 1 Approve | Human approval required for every action (default) |
| 2 Bounded auto | Reversible, in-blast-radius actions run automatically under contract |
| 3 Expanded auto | More actions autonomous after proven reliability (post-MVP) |

---

## 12. AWS IAM model
- **Read role** (broad read on CloudWatch/ECS/Lambda/ELBv2/CloudTrail) for observation.
- **Per-service write roles**, least-privilege (e.g. only `ecs:UpdateService` + `ecs:DescribeServices` on a specific cluster/service ARN), assumed via STS at execution time. Provide IAM policy templates under `infra/iam/`. Onboarding starts **read-only**; write roles are added explicitly per service.

## 13. Config & secrets
- `config/` validates env with zod at boot (fail fast): AWS account ids/regions, role ARNs, `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `DATABASE_URL`.
- Contracts loaded from `contracts/*.yaml` + DB; invalid contract = boot failure.

## 14. Testing strategy
- **Unit:** contract engine + policy + blast radius (exhaustive); each action's param schema, snapshot, and revert with `aws-sdk-client-mock`.
- **Synthetic harness** (`test/synthetic/`): scripted failures for all four incident types; assert correct detection, classification, policy decision, execution (against mocks/localstack or a sandbox account), verification, and induced-failure auto-rollback.
- **Unsafe-write gate:** the §10 invariants as failing-by-default tests; CI blocks merge if any unsafe path can reach `execute()`.
- **Shadow metrics:** MTTD, MTTA, classification accuracy, rollback success, false-positive rate logged from synthetic + (later) real shadow runs.

---

## 15. Milestones & acceptance criteria

Build in this order. Each milestone ends with green tests + a short demo.

- **M1 — Skeleton, types, audit, contract loader.**
  AC: zod types compile; load + validate the sample contract; append audit records; `verifyChain()` passes; `replay()` returns ordered events.
- **M2 — Detectors + classifier + context graph (read-only).**
  AC: all four detectors fire correctly in the synthetic harness; classifier emits schema-valid hypotheses with confidence; **no writes** anywhere; metrics logged.
- **M3 — Slack observe mode.**
  AC: incident posts to Slack with evidence + confidence + (inert) proposed action + blast radius; timeline updates on state changes; buttons present but execution still gated off.
- **M4 — Executor + verifier + auto-rollback (ECS + Lambda rollback).**
  AC: in sandbox/localstack, snapshot → execute under approval → verify; on induced verification failure, **auto-revert** restores prior state; all AWS calls audited.
- **M5 — Approval workflow + autonomy gating.**
  AC: Level-1 approve/deny works end-to-end; Level-2 triggers only for reversible, in-blast-radius actions; **`unsafe-write.test.ts` (all §10 invariants) passes**.
- **M6 — Learning loop + postmortem + fix-as-code PR + MCP server/client.**
  AC: resolved incident emits a postmortem draft + proposed reusable contract; `open_fix_as_code_pr` opens a real PR; MCP `execute_remediation` + `dryRun` callable; ingest from a mock upstream diagnosis normalizes to an `Incident`.

## 16. Success metrics & Day-90 gate
Track: MTTD, MTTA, MTTR; classification accuracy; confidence calibration; rollback success rate; false-positive remediation attempts; **share of incidents resolved without human action** per autonomy level; reversibility SLA (time-to-revert); and a hard **zero-unsafe-write** count.
**Gate:** enable Level-2 for one reversible action on one service only if classification accuracy, rollback success, and a zero-unsafe-write record clear target thresholds with ≥1 design partner.

## 17. Open questions (surface, don't guess)
1. Single-tenant per customer (in their VPC) vs. multi-tenant SaaS for MVP? Affects IAM, data residency, audit isolation.
2. "Previous known-good" source of truth for rollback targets — deployment history vs. an explicit `last-good` tag the customer maintains?
3. Feature-flag provider for `disable_feature_flag` (referenced in contracts) — which one(s) for MVP, or defer the action?
4. Verification baselines — static thresholds (contract) vs. learned per-service baselines?
5. Postgres-only vs. add Redis/BullMQ for the state machine at MVP scale?
6. Confidence grading of upstream diagnoses (Datadog/PagerDuty/RCA). Upstream `confidence` is currently trusted as-is (a prior). Path: **(a) MVP — LLM-as-judge** (Claude + rubric) that re-scores against the evidence and may only *lower* confidence or flag for review, never authorize (preserves golden rule #2). **(b) Later — fine-tuned/distilled grader** once the hash-chained audit log has accumulated a labeled corpus (diagnosis → action → verification → outcome). Not for MVP: no training data exists yet. Open: rubric design, judge latency/cost budget per incident, how a low grade maps onto the policy gate.

> When in doubt about anything touching production writes, prefer **escalate to human** over acting. Safety > coverage.
