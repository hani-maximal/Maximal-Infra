# Design Partner Validation Playbook

End-to-end validation scenarios for every meaningful combination of incident type, connector source, automation depth, plan tier, and terminal outcome. Run these against a non-production AWS account before connecting any design partner.

---

## Quick reference

### Actions registered in the engine

| Action | Incident families | Reversible |
|---|---|---|
| `restart_ec2_instance` | ec2_* | Yes |
| `rollback_ecs_task_definition` | ecs_*, fargate_*, post_deploy_5xx_spike, deploy_failed_or_stuck | Yes |
| `rollback_lambda_alias` | lambda_* | Yes |
| `force_new_ecs_deployment` | ecs_* (no deploy correlation) | Partial |

### Contract approval modes

| Incident type | Approval mode | Can auto-execute | Rollback if failed |
|---|---|---|---|
| post_deploy_5xx_spike | auto_under_blast_radius | Yes | Yes |
| lambda_error_spike | auto_under_blast_radius | Yes | Yes |
| lambda_throttling_concurrency_exhausted | auto_under_blast_radius | Yes | Yes |
| lambda_timeout_duration_spike | auto_under_blast_radius | Yes | Yes |
| fargate_service_unhealthy | auto_under_blast_radius | Yes (rollback only) | Yes |
| sqs_worker_backlog_saturation | auto_under_blast_radius | Yes | Yes |
| ec2_instance_status_check_failed | always_human | Only with AUTOMATED trust | No |
| ecs_service_unhealthy | always_human | Only with AUTOMATED trust | Yes |
| rds_connection_saturation | always_human | Never (no auto action types) | Yes |
| elasticache_memory_pressure_evictions | always_human | Never (no auto action types) | No |
| alb_latency_saturation | always_human | Only with AUTOMATED trust | Yes |
| alb_target_unhealthy_no_deploy | always_human | Only with AUTOMATED trust | Yes |
| dependency_5xx_timeout_spike | always_human | Only with AUTOMATED trust | Yes |
| ec2_asg_unhealthy_hosts | always_human | Only with AUTOMATED trust | Yes |
| ec2_disk_full | always_human | Only with AUTOMATED trust | No |
| ecs_image_pull_failed | always_human | Only with AUTOMATED trust | Yes |
| ecs_task_placement_capacity_failed | always_human | Only with AUTOMATED trust | No |
| eks_deployment_rollout_failed | always_human | Only with AUTOMATED trust | Yes |
| eks_node_not_ready | always_human | Only with AUTOMATED trust | No |
| fargate_task_oom_kill | always_human | Only with AUTOMATED trust | Yes |
| lightsail_container_deployment_failed | always_human | Only with AUTOMATED trust | Yes |
| lightsail_instance_unhealthy | always_human | Only with AUTOMATED trust | No |
| deploy_failed_or_stuck | auto_under_blast_radius | Yes | Yes |

### Connector sources per incident type

| Source | Incident types supported |
|---|---|
| `self_detect` | All (HTTP health probe triggers ec2_instance_status_check_failed; others via demo endpoint) |
| `aws_devops_agent` | post_deploy_5xx_spike, ecs_service_unhealthy, lambda_*, fargate_*, rds_*, elasticache_*, sqs_*, alb_*, ec2_asg_*, deploy_* |
| `datadog` | post_deploy_5xx_spike, ecs_service_unhealthy, lambda_*, fargate_*, rds_*, elasticache_*, sqs_*, alb_* |
| `pagerduty` | lambda_error_spike, ecs_service_unhealthy |

### Plan tier capabilities

| Capability | Starter | Team | Scale | Enterprise |
|---|---|---|---|---|
| Max services | 3 | 20 | Unlimited | Unlimited |
| Autonomy modes | observe | observe, approve | all | all |
| Custom trust configs | No | No | Yes | Yes |
| Slack approval workflow | No | Yes | Yes | Yes |
| Audit export | No | No | Yes | Yes |
| Custom contracts | No | No | No | Yes |
| SSO | No | No | No | Yes |
| Connectors | AWS | AWS, Slack | All | All |

---

## Part 1 — Environment setup

### 1.1 Required env vars

```bash
# Core
DATABASE_URL=postgres://...          # maximal-ops RDS
REDIS_URL=redis://...                # ElastiCache
ANTHROPIC_API_KEY=sk-ant-...

# Auth
MAXIMAL_JWT_SECRET=...
MAXIMAL_OPERATOR_USERNAME=admin
MAXIMAL_OPERATOR_PASSWORD=...

# Engine mode (start with observe, promote to bounded_auto after validation)
MAXIMAL_MODE=observe

# Tenant
DEFAULT_TENANT_ID=<uuid-for-design-partner>

# Slack (Team tier and above)
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...

# AWS
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...   # or use task role in production
AWS_SECRET_ACCESS_KEY=...
```

### 1.2 AWS resources needed per scenario

| Resource | Required for | Minimum setup |
|---|---|---|
| EC2 instance (stoppable) | ec2_instance_status_check_failed, ec2_asg_unhealthy_hosts, ec2_disk_full | t3.micro in staging VPC |
| ECS cluster + service | ecs_*, post_deploy_5xx_spike, fargate_*, deploy_failed_or_stuck | Non-prod cluster, 1 service, 2 task definitions |
| Lambda function + alias | lambda_* | Function with `live` alias pointing to version N and known-bad version N+1 |
| ALB + target group | alb_*, post_deploy_5xx_spike, dependency_5xx_timeout_spike | Attached to ECS service above |
| RDS instance | rds_connection_saturation | db.t3.micro, can simulate saturation via connection flooding |
| ElastiCache cluster | elasticache_memory_pressure_evictions | cache.t3.micro, maxmemory-policy=allkeys-lru for testing |
| SQS queue + ECS worker | sqs_worker_backlog_saturation | Queue + worker service, pause worker to build backlog |
| EKS cluster | eks_deployment_rollout_failed, eks_node_not_ready | Single node group, non-prod |

### 1.3 Pre-flight checks

```
GET /api/health
→ { ok: true, mode: "observe", contractCount: 23, auditChainValid: true, authEnabled: true }
```

Verify all 23 contracts loaded. If fewer, check for YAML parse errors in boot logs.

---

## Part 2 — Terminal path reference

Every incident ends in one of these eight states. All scenarios below are combinations of these paths.

### Path A — AUTO → RESOLVED → CLOSED
Policy passes, confidence meets floor, contract auto-executes, verification succeeds.
```
DETECTED → CLASSIFIED → CONTRACT_MATCHED → EXECUTING → VERIFYING → RESOLVED → CLOSED
Audit events: signal, hypothesis, classification, contract_match, policy_decision(AUTO),
              snapshot, aws_action, verification(ok:true), postmortem, state_change(CLOSED)
```

### Path B — AUTO → verify fails → ROLLED_BACK → ESCALATED
Policy passes, executes, verification fails, rollback triggers.
```
DETECTED → CLASSIFIED → CONTRACT_MATCHED → EXECUTING → VERIFYING → ROLLING_BACK → ROLLED_BACK → ESCALATED
Audit events: ... aws_action, verification(ok:false), rollback, escalation(reason:verification_failed)
```

### Path C — AUTO → verify fails → ESCALATED (no rollback)
Same as B but `rollback_if_failed: false` in contract.
```
DETECTED → CLASSIFIED → CONTRACT_MATCHED → EXECUTING → VERIFYING → ESCALATED
Audit events: ... verification(ok:false), escalation(reason:verification_failed, rollbackAttempted:false)
```

### Path D — APPROVE → human approves → RESOLVED → CLOSED
Contract requires human, operator approves, execution succeeds.
```
DETECTED → CLASSIFIED → CONTRACT_MATCHED → AWAITING_APPROVAL → EXECUTING → VERIFYING → RESOLVED → CLOSED
Audit events: ... policy_decision(APPROVE), approval_request, approval_granted, snapshot, aws_action, verification(ok:true)
```

### Path E — APPROVE → human approves → verify fails → ROLLED_BACK → ESCALATED
Human approves, execution fails verification, rollback triggers.
```
DETECTED → CLASSIFIED → CONTRACT_MATCHED → AWAITING_APPROVAL → EXECUTING → VERIFYING → ROLLING_BACK → ROLLED_BACK → ESCALATED
```

### Path F — APPROVE → human denies → ESCALATED
Slack Deny button pressed.
```
DETECTED → CLASSIFIED → CONTRACT_MATCHED → AWAITING_APPROVAL → ESCALATED
Audit events: ... approval_request, approval_denied, escalation(reason:approval_denied)
```

### Path G — ESCALATED at policy (confidence / blast radius / evidence)
Policy gate fires before any execution attempt.
```
DETECTED → CLASSIFIED → ESCALATED
Audit events: classification, escalation(reasons:[confidence_below_contract_minimum | blast_radius_exceeded | insufficient_corroborating_evidence | ...])
```

### Path H — ESCALATED at contract match (no contract or missing context)
No matching contract for this incident type/source combination.
```
DETECTED → CLASSIFIED → ESCALATED
Audit events: classification, escalation(reason:no_matching_contract | missing_service_context)
```

---

## Part 3 — ECS / Fargate scenarios

### 3.1 post_deploy_5xx_spike — happy path (Path A)

**Setup:** ECS service with ALB, deploy a bad task definition that returns 500s.

**Trust config:** SUPERVISED (default)
**System mode:** bounded_auto
**Source:** aws_devops_agent or datadog

```
POST /api/incidents/demo { type: "post_deploy_5xx_spike", confidence: 0.97, environment: "staging" }
POST /api/incidents/:id/plan
→ policy.decision: "AUTO"  (auto_under_blast_radius passes, confidence ≥ 0.95)
→ engine fires execute() immediately
→ rollback_ecs_task_definition runs against staging cluster
→ verifier checks alb_5xx_rate < 0.5% AND p95_latency < 500ms
→ CLOSED
```

**Pass criteria:**
- `policy.decision === "AUTO"`
- Snapshot row written before execute
- Audit chain valid on `/api/incidents/:id/replay`
- Outcome row in `incident_outcomes` table
- Contract proposal queued to BullMQ

---

### 3.2 post_deploy_5xx_spike — CONSERVATIVE trust config (Path D)

**Trust config:** `PUT /api/trust-configs { incidentType: "post_deploy_5xx_spike", automationDepth: "CONSERVATIVE" }`
**System mode:** bounded_auto

```
POST /api/incidents/:id/plan
→ policy.decision: "AUTO" (contract passes)
→ #applyTrustOverride: CONSERVATIVE downgrades AUTO → APPROVE
→ policy.decision: "APPROVE", reasons: [..., "trust_config_conservative"]
→ state: AWAITING_APPROVAL
→ Slack message sent to #prod-incidents
→ operator clicks Approve
→ EXECUTING → VERIFYING → CLOSED
```

**Pass criteria:**
- Audit `policy_decision` event has `trustOverrideApplied: true`, `automationDepth: "CONSERVATIVE"`
- Slack approval message received
- Execution only starts after Slack approval

---

### 3.3 post_deploy_5xx_spike — verification failure + rollback (Path B)

```
POST /api/incidents/:id/simulate-verification-failure
POST /api/incidents/demo { type: "post_deploy_5xx_spike", confidence: 0.97 }
POST /api/incidents/:id/plan
→ AUTO executes
→ verifier.failNext fires → verification fails
→ rollback_ecs_task_definition runs (rollback_if_failed: true)
→ ROLLED_BACK → ESCALATED
```

**Pass criteria:**
- Audit has `rollback` event
- Incident ends in `ESCALATED`
- Outcome row has `rollbackTriggered: true`, `verificationPassed: false`

---

### 3.4 post_deploy_5xx_spike — all three connector sources

Run the same scenario three times, changing the incident `source` field.

| Source | Expected |
|---|---|
| `aws_devops_agent` | Contract matches (`source` array includes it), plan proceeds normally |
| `datadog` | Contract matches, plan proceeds normally |
| `self_detect` | Contract matches, plan proceeds normally |
| `pagerduty` | Contract does NOT match (`source` not in contract array) → Path H |

**Pass criteria for pagerduty:** `escalation` audit event with `reason: "no_matching_contract"`

---

### 3.5 ecs_service_unhealthy — always_human, SUPERVISED (Path D)

**Setup:** Stop tasks manually in ECS so `runningCount < desiredCount`.
**Trust config:** SUPERVISED (default)
**System mode:** bounded_auto

```
POST /api/incidents/demo { type: "ecs_service_unhealthy", confidence: 0.96 }
POST /api/incidents/:id/plan
→ policy.decision: "APPROVE" (always_human, SUPERVISED does not override)
→ AWAITING_APPROVAL
→ Slack approval message
→ operator approves
→ rollback_ecs_task_definition or force_new_ecs_deployment
→ VERIFYING → CLOSED
```

---

### 3.6 ecs_service_unhealthy — AUTOMATED trust override (Path A)

**Trust config:** `PUT /api/trust-configs { incidentType: "ecs_service_unhealthy", automationDepth: "AUTOMATED" }`

```
POST /api/incidents/:id/plan
→ evaluatePolicy → APPROVE (contract_requires_human)
→ #applyTrustOverride: AUTOMATED, only reason is contract_requires_human → upgrades to AUTO
→ policy.decision: "AUTO", trustOverrideApplied: true
→ executes immediately without Slack prompt
```

**Pass criteria:**
- No Slack message sent
- `trustOverrideApplied: true` in audit
- Full snapshot+revert capability still present (reversible action)

---

### 3.7 fargate_service_unhealthy — auto path (Path A)

**Source:** aws_devops_agent
**System mode:** bounded_auto

```
POST /api/incidents/demo { type: "fargate_service_unhealthy", confidence: 0.96 }
POST /api/incidents/:id/plan
→ auto_under_blast_radius, rollback_ecs_task_definition is in allowed_action_types
→ policy.decision: "AUTO"
→ executes, verifies ecs_running_task_count == desired_count
→ CLOSED
```

---

### 3.8 ecs_image_pull_failed — escalate path (Path G)

This contract has `always_human` but more importantly the action is `rollback_ecs_task_definition` — if there's no prior task definition to roll back to, the preconditions fail.

```
POST /api/incidents/demo { type: "ecs_image_pull_failed", confidence: 0.95 }
POST /api/incidents/:id/plan
→ APPROVE (always_human)
→ operator approves
→ preconditions check: is there a previous stable task definition?
→ if no: preconditions fail → throws "Action preconditions failed" → ESCALATED
```

---

## Part 4 — Lambda scenarios

### 4.1 lambda_error_spike — auto path (Path A)

**Setup:** Lambda function `billing-handler` with alias `live` pointing to version 41. Deploy bad version 42, update alias.
**Source:** aws_devops_agent
**System mode:** bounded_auto

```
POST /api/incidents/demo { type: "lambda_error_spike", confidence: 0.97 }
POST /api/incidents/:id/plan
→ auto_under_blast_radius, rollback_lambda_alias in allowed_action_types
→ policy.decision: "AUTO"
→ snapshot: records current alias → version 42
→ rollback_lambda_alias: updates alias back to version 41
→ verify: error_rate < 1% AND throttles == 0
→ CLOSED
```

---

### 4.2 lambda_error_spike — Datadog source

```
Create incident with source: "datadog"
→ contract source array includes datadog → matches
→ same AUTO path as 4.1
```

**Pass criteria:** Identical to 4.1. Datadog and aws_devops_agent are interchangeable sources for this contract.

---

### 4.3 lambda_error_spike — PagerDuty source

```
Create incident with source: "pagerduty"
→ contract source array includes pagerduty → matches
→ same AUTO path
```

---

### 4.4 lambda_error_spike — low confidence (Path G)

```
POST /api/incidents/demo { type: "lambda_error_spike", confidence: 0.88 }
→ confidence 0.88 < floor 0.90 → hard blocked at contract validation
```

Actually, the confidence floor is checked at `evaluatePolicy`:
```
incident.confidence (0.88) < contract.min_confidence (0.95)
→ reasons: ["confidence_below_contract_minimum"]
→ decision: "ESCALATE"
→ Path G
```

**Pass criteria:** `escalation` with `confidence_below_contract_minimum`, no AWS call made.

---

### 4.5 lambda_error_spike — single evidence kind (Path G)

Confidence is fine (0.97) but only one type of evidence (metric only, no deploy_event).

```
→ evaluatePolicy: distinctEvidenceKinds = 1 < MIN_CORROBORATING_EVIDENCE_KINDS (2)
→ reasons: ["insufficient_corroborating_evidence"]
→ ESCALATE
```

---

### 4.6 lambda_throttling_concurrency_exhausted — auto path

Source: `aws_devops_agent`. Same flow as lambda_error_spike. Contract is `auto_under_blast_radius`.

Verify checks: `lambda_throttle_count == 0 for 5m` AND `error_rate < 1% for 5m`.

---

### 4.7 lambda_timeout_duration_spike — auto path

Source: `aws_devops_agent`. Same flow. Rollback alias to previous version.

Verify checks: `p99_duration < 3000ms for 5m`.

---

## Part 5 — EC2 scenarios

### 5.1 ec2_instance_status_check_failed — always_human, SUPERVISED (Path D)

**Setup:** EC2 instance in staging. Stop it to trigger health probe failure.
**Source:** self_detect (HTTP health detector)
**System mode:** bounded_auto

```
Health probe → 3 consecutive failures → incident created automatically
GET /api/incidents → incident in DETECTED state
POST /api/incidents/:id/plan
→ always_human, SUPERVISED → APPROVE
→ Slack message: "Restart EC2 instance i-xxx in us-east-1?"
→ operator clicks Approve
→ snapshot: instance state (stopped/running)
→ restart_ec2_instance: calls StartInstances
→ verify: http_status 200 for 5m
→ CLOSED
```

**Pass criteria:**
- HTTP detector auto-created the incident (no manual POST required)
- Slack message received with instance ID and region
- EC2 starts successfully
- `rollback_if_failed: false` — if verify fails, ESCALATED with no rollback attempt

---

### 5.2 ec2_instance_status_check_failed — AUTOMATED trust (Path A)

**Trust config:** `{ incidentType: "ec2_instance_status_check_failed", automationDepth: "AUTOMATED" }`

```
Health probe fails → incident created
POST /api/incidents/:id/plan
→ always_human → APPROVE (contract_requires_human)
→ AUTOMATED: only reason is contract_requires_human → AUTO
→ restarts EC2 immediately, no Slack prompt
→ verify → CLOSED
```

**Pass criteria:**
- No Slack message sent
- EC2 restarted without human approval
- `trustOverrideApplied: true` in audit

---

### 5.3 ec2_instance_status_check_failed — observe mode (blocks all execution)

**System mode:** observe

```
POST /api/incidents/:id/plan
→ evaluatePolicy: mode === "observe" → APPROVE (observe_mode_blocks_execution)
→ Even with AUTOMATED trust config: modeBlockers includes observe_mode → trust override does NOT apply
→ AWAITING_APPROVAL forever (or until mode changes)
```

**Pass criteria:** `observe_mode_blocks_execution` in reasons, no execution regardless of trust config.

---

### 5.4 ec2_asg_unhealthy_hosts — always_human, Datadog source

Source: `datadog`. Contract includes `datadog` as valid source. APPROVE path, human approves, `restart_ec2_instance` targets the specific unhealthy host.

---

### 5.5 ec2_disk_full — verify failure path, no rollback (Path C)

Contract has `rollback_if_failed: false`. Even if AUTOMATED trust forces execution, if disk usage doesn't drop after the action (disk is full — restarting doesn't clear it), verify fails and ESCALATED with no rollback attempt.

```
→ verify: disk_usage < 80% → fails (disk still full)
→ rollback_if_failed: false → skip rollback
→ ESCALATED directly
```

---

## Part 6 — ALB / network scenarios

### 6.1 alb_latency_saturation — SUPERVISED, human approves (Path D)

Source: `aws_devops_agent`. `always_human` contract. Human approves. Action is `rollback_ecs_task_definition` (the ALB is attached to an ECS service).

Verify: `alb_p99_latency < 500ms for 5m` AND `alb_target_5xx_rate < 0.5%`.

---

### 6.2 alb_target_unhealthy_no_deploy — no deploy correlation

This incident fires when ALB targets are unhealthy but no recent deployment is detected. No `deployCorrelation` on the incident.

`chooseAction` in the orchestrator falls through to `force_new_ecs_deployment` (the fallback when no deploy correlation). Always_human, so APPROVE unless AUTOMATED trust is set.

---

### 6.3 dependency_5xx_timeout_spike — blast radius exceeded (Path G)

This incident affects a downstream dependency that other services call. If `affectedServices.length > max_affected_services` (contract default: 1), blast radius check fires.

```
→ evaluatePolicy: blastRadius.affectedServices.length = 3 > max_affected_services = 1
→ reasons: ["blast_radius_exceeded"]
→ ESCALATE
```

**Pass criteria:** No execution, `blast_radius_exceeded` in audit reasons.

---

## Part 7 — Data layer scenarios (escalate-only)

### 7.1 rds_connection_saturation — always escalates to human

`allowed_action_types: []` means no auto execution. Even AUTOMATED trust only applies when the decision is APPROVE. Here:

```
evaluatePolicy:
→ mode: always_human → APPROVE (contract_requires_human)
→ AUTOMATED trust: only reason is contract_requires_human → upgrades to AUTO
→ evaluatePolicy checks action.type in allowed_action_types → []
```

Wait — the `allowed_action_types` check in `evaluatePolicy` comes AFTER the `always_human` check, so it's never reached. The AUTOMATED upgrade works. However, the available actions are `scale_ecs_service_down` and `open_fix_as_code_pr` — neither of which are currently registered in the `ActionRegistry`. So `this.actions.get(selected.actionType)` returns null → `throw new Error("Action is not registered")` → ESCALATED.

**Pass criteria:** ESCALATED with "Action is not registered" — confirms unregistered actions are safely rejected.

---

### 7.2 elasticache_memory_pressure_evictions — advisory only

Same pattern as RDS. No registered auto actions. Diagnostic + escalate. Contract drafts a PR proposal (`open_fix_as_code_pr`) but that action isn't registered.

**Pass criteria:** Incident ESCALATED, audit shows classification + evidence summary from classifier.

---

### 7.3 sqs_worker_backlog_saturation — auto path (when scale_ecs_service is registered)

`auto_under_blast_radius`. `scale_ecs_service` is in `allowed_action_types`. Once `scale_ecs_service` is registered in `ActionRegistry`, this is a clean AUTO path.

**Currently:** ESCALATED because `scale_ecs_service` is not registered.
**After registering the action:** Path A — scales worker desired count up, verifies backlog decreasing.

---

## Part 8 — EKS scenarios

### 8.1 eks_deployment_rollout_failed — always_human, human approves

Source: `aws_devops_agent`. Action: `rollback_ecs_task_definition` (EKS rollback maps to this for MVP). Human approves.

Verify: deployment rollout complete, pods running.

---

### 8.2 eks_node_not_ready — no rollback, ESCALATED on verify failure (Path C)

`rollback_if_failed` check. If the node doesn't come back healthy after restart action, no rollback is attempted (you can't "undo" a node restart that didn't help). ESCALATED directly.

---

## Part 9 — Lightsail scenarios

### 9.1 lightsail_container_deployment_failed — always_human

Source: `aws_devops_agent`. Action: `rollback_ecs_task_definition` (adapted for Lightsail container service revision rollback). Human approves.

---

### 9.2 lightsail_instance_unhealthy — no rollback

`rollback_if_failed: false`. If instance restart doesn't resolve the health check, ESCALATED directly. No rollback attempt.

---

## Part 10 — Automation depth variations (same incident, three depths)

Run the same `post_deploy_5xx_spike` incident three times with different trust configs. This isolates the trust override logic from contract logic.

### CONSERVATIVE
```
PUT /api/trust-configs { incidentType: "post_deploy_5xx_spike", automationDepth: "CONSERVATIVE" }
POST /api/incidents/demo { type: "post_deploy_5xx_spike", confidence: 0.97 }
POST /api/incidents/:id/plan
→ contract: auto_under_blast_radius → evaluatePolicy → AUTO
→ trust override: CONSERVATIVE → AUTO downgrades to APPROVE
→ AWAITING_APPROVAL → Slack prompt
```
Expected: human in the loop even though contract allows auto.

### SUPERVISED
```
PUT /api/trust-configs { incidentType: "post_deploy_5xx_spike", automationDepth: "SUPERVISED" }
→ trust override: no-op (follow contract)
→ policy: AUTO (contract is auto_under_blast_radius)
→ executes immediately
```
Expected: contract's own setting respected, no override.

### AUTOMATED (on always_human contract — use ec2_instance_status_check_failed)
```
PUT /api/trust-configs { incidentType: "ec2_instance_status_check_failed", automationDepth: "AUTOMATED" }
POST /api/incidents/demo { type: "ec2_instance_status_check_failed", confidence: 0.95 }
POST /api/incidents/:id/plan
→ contract: always_human → evaluatePolicy → APPROVE (contract_requires_human)
→ trust override: AUTOMATED, sole reason is contract_requires_human → AUTO
→ executes without human prompt
→ trustOverrideApplied: true in audit
```
Expected: no Slack message, immediate execution, safety invariants (snapshot+revert) still present.

---

## Part 11 — Plan tier validation

### 11.1 Starter — service cap enforcement

```
Set tenant subscription_tier = "starter"
Add 3 services (create 3 incidents with different services)
→ POST /api/incidents/demo { service: "service-4" }
→ 402 Payment Required: "Service limit reached for Starter plan (max 3)"
```

**Pass criteria:** 402 on the 4th unique service.

---

### 11.2 Starter — trust config blocked

```
Set subscription_tier = "starter"
PUT /api/trust-configs { incidentType: "ec2_instance_status_check_failed", automationDepth: "AUTOMATED" }
→ 402 Payment Required: "Custom trust configs require Scale plan or higher"
```

---

### 11.3 Team — trust config still blocked (Scale required)

```
Set subscription_tier = "team"
PUT /api/trust-configs { ... }
→ 402 Payment Required
```

---

### 11.4 Scale — trust config allowed

```
Set subscription_tier = "scale"
PUT /api/trust-configs { incidentType: "ec2_instance_status_check_failed", automationDepth: "AUTOMATED" }
→ 200 OK
```

---

### 11.5 Starter — observe mode only

```
Set subscription_tier = "starter"
Set MAXIMAL_MODE = "bounded_auto"
POST /api/incidents/:id/plan
→ mode gating should block bounded_auto for Starter
→ treated as observe mode
→ APPROVE (observe_mode_blocks_execution)
```

---

### 11.6 Team — Slack connector allowed

```
Set subscription_tier = "team"
Configure SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET
POST /api/incidents/:id/plan → AWAITING_APPROVAL
→ Slack message arrives in #prod-incidents
```

---

### 11.7 Starter — Slack connector blocked

```
Set subscription_tier = "starter"
→ Slack notifier should not fire even if tokens are configured
→ No Slack message on AWAITING_APPROVAL
```

---

## Part 12 — Safety invariant checks

Run these regardless of plan or configuration. These must never fail.

### 12.1 No execution below confidence floor

```
POST /api/incidents/demo { type: "post_deploy_5xx_spike", confidence: 0.85 }
POST /api/incidents/:id/plan
→ 0.85 < contract min_confidence 0.95 → ESCALATE
→ No snapshot, no AWS call
```

### 12.2 No execution below absolute floor

```
POST /api/incidents/demo { confidence: 0.89 }
→ Even if contract min_confidence is 0.90, 0.89 < 0.90 floor → ESCALATE
```

### 12.3 No execution with single evidence kind

```
Create incident with evidence array containing only "metric" items (no alarm, log, deploy_event)
→ distinctEvidenceKinds = 1 < MIN_CORROBORATING_EVIDENCE_KINDS (2) → ESCALATE
```

### 12.4 No execution without snapshot

The engine throws if snapshot isn't persisted before execute. Verify by checking:
```
GET /api/incidents/:id/replay
→ "snapshot" audit event must precede every "aws_action" event
→ If snapshot event is absent or comes after aws_action: chain integrity failure
```

### 12.5 No execution in observe mode (even with AUTOMATED trust)

```
MAXIMAL_MODE = "observe"
PUT /api/trust-configs { automationDepth: "AUTOMATED" }
POST /api/incidents/:id/plan
→ observe_mode_blocks_execution in reasons
→ trust override checks modeBlockers — observe mode is a blocker → no override
→ AWAITING_APPROVAL (never executes)
```

### 12.6 Audit chain integrity

After any completed incident:
```
GET /api/incidents/:id/replay
→ { valid: true, records: [...] }
→ valid must be true
→ Each record's prevHash must match the previous record's hash
→ Records must be in chronological order
```

### 12.7 ESCALATE decisions never overridden by trust config

```
Create incident with confidence below floor → ESCALATE
PUT /api/trust-configs { automationDepth: "AUTOMATED" }
→ Re-run plan (or verify the logic directly)
→ ESCALATE outcome unchanged — trust override is structurally inert to ESCALATE
```

### 12.8 Snapshot persists across the full execute path

```
Verify orchestrator.snapshots.has(incidentId) === true before execute() returns
Verify snapshot event in audit log
Verify revert() is callable (for reversible actions)
```

---

## Part 13 — Learning pipeline validation

Run after completing at least one incident through to CLOSED.

### 13.1 Outcome written after CLOSED

```
Complete any incident through Path A or D
Wait ~15s (outcome-writer queue delay)
GET /api/learning/calibration
→ At minimum one outcome row exists for the tenant
```

Or query directly:
```sql
SELECT * FROM incident_outcomes WHERE tenant_id = '...' ORDER BY created_at DESC LIMIT 5;
```

### 13.2 Outcome written after ESCALATED

```
Complete any incident through Path G or H
Wait ~15s
→ Outcome row exists with policy_decision = "ESCALATE", verification_passed = null
```

### 13.3 Contract proposal queued after CLOSED

```
Complete incident through CLOSED
Wait ~15s
GET /api/learning/proposals?status=pending
→ At least one proposal exists for the incident's type
→ proposed_yaml is non-empty, rationale is non-empty
```

### 13.4 Proposal approve/reject

```
GET /api/learning/proposals?status=pending → pick an id
PATCH /api/learning/proposals/:id { status: "approved" }
→ 200 OK
PATCH /api/learning/proposals/:id { status: "rejected" }
→ 200 OK
GET /api/learning/proposals?status=approved → proposal appears
```

**Note:** Until S3 contract storage is built, approval changes the status flag only. The approved YAML does not go live. Validate that the system does NOT auto-load it.

### 13.5 Classifier RAG context (after multiple incidents)

After 5+ CLOSED incidents of the same type:
```
Run a new incident of the same type
Check the audit classification event:
→ ragAugmented: true
→ evidenceSummary contains reference to historical outcomes
→ classifier calibrationNote mentions prior context
```

### 13.6 Calibration records (manual trigger)

Calibration runs on a schedule. To validate manually:
```
Import and call runCalibration({ tenantId }) directly in a test script
→ calibration_records rows written for buckets with ≥ 3 samples
GET /api/learning/calibration
→ Records visible in API response
```

---

## Part 14 — Connector-specific workflows

### 14.1 Slack approval — full round-trip

**Requires:** SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, Slack Socket Mode connected

```
1. Complete plan() with policy.decision = "APPROVE"
2. Verify Slack message arrives in the configured channel (#prod-incidents)
3. Message contains: service, incident type, proposed action, Approve / Deny buttons
4. Click Approve → incident transitions AWAITING_APPROVAL → EXECUTING
5. Outcome message posted to Slack channel (CLOSED or ESCALATED)
```

**Pass criteria:** Full Slack round-trip without manual API calls.

### 14.2 Slack deny — full round-trip

```
1. Incident in AWAITING_APPROVAL with Slack message
2. Click Deny
3. Incident transitions to ESCALATED
4. Audit event: approval_denied, then escalation(reason:approval_denied)
5. Slack posts outcome message
```

### 14.3 Datadog source — incident ingestion

**Requires:** Datadog webhook or direct API call with `source: "datadog"`

```
POST /api/incidents { ..., source: "datadog", type: "post_deploy_5xx_spike" }
→ Contract includes datadog as valid source → matches
→ Proceeds normally
```

**Pass criteria:** `source: "datadog"` incidents handled identically to `aws_devops_agent`.

### 14.4 PagerDuty source — incident ingestion

```
POST incident with source: "pagerduty"
→ Only lambda_error_spike and ecs_service_unhealthy contracts accept pagerduty
→ Other incident types → Path H (no_matching_contract)
```

### 14.5 HTTP health detector — automatic incident creation

**Requires:** `MAXIMAL_HEALTH_URL`, `MAXIMAL_HEALTH_SERVICE`, `MAXIMAL_HEALTH_ENV` configured

```
1. Start engine with health detector configured
2. Stop the monitored service / block the URL
3. After MAXIMAL_HEALTH_FAIL_THRESHOLD consecutive failures (default 3):
   → Incident auto-created with type: "ec2_instance_status_check_failed", source: "self_detect"
   → Audit signal event written automatically
4. Restore service
5. Verify incident was created without any manual API call
```

---

## Completion checklist

Before signing off on a design partner environment, confirm each item below has been run and passed.

**Core execution**
- [ ] Path A (AUTO → CLOSED) — at least one ECS and one Lambda incident
- [ ] Path B (AUTO → rollback → ESCALATED) using simulate-verification-failure
- [ ] Path D (APPROVE → human approves → CLOSED) — ec2 or ecs_service_unhealthy
- [ ] Path F (APPROVE → human denies → ESCALATED) — Slack deny
- [ ] Path G (policy ESCALATE) — confidence below floor
- [ ] Path G (policy ESCALATE) — single evidence kind
- [ ] Path H (no contract match) — unsupported source or unregistered incident type

**Trust config**
- [ ] CONSERVATIVE downgrades AUTO → APPROVE
- [ ] SUPERVISED follows contract unchanged
- [ ] AUTOMATED upgrades APPROVE → AUTO (always_human contract)
- [ ] Observe mode blocks AUTOMATED trust override

**Plan tiers**
- [ ] Starter: 4th service returns 402
- [ ] Starter/Team: trust config PUT returns 402
- [ ] Scale: trust config PUT succeeds

**Safety invariants**
- [ ] Confidence below floor → ESCALATE, no AWS call
- [ ] Single evidence kind → ESCALATE, no AWS call
- [ ] Snapshot event precedes every aws_action event in audit replay
- [ ] Audit chain `valid: true` on every completed incident
- [ ] Observe mode: no execution regardless of trust config

**Learning pipeline**
- [ ] Outcome row written after CLOSED
- [ ] Outcome row written after ESCALATED
- [ ] Contract proposal appears after CLOSED
- [ ] Proposal approve/reject endpoints work

**Connectors**
- [ ] Slack approval round-trip
- [ ] Slack deny round-trip
- [ ] HTTP health detector auto-creates incident (if configured)
