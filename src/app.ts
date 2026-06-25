import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyJwt from "@fastify/jwt";
import { z } from "zod";
import { createActionRegistry, MockAwsAdapter } from "./actions.js";
import {
  AuditStore,
  ContextGraph,
  ContractRegistry,
  DeterministicVerifier,
  IncidentRepository
} from "./core.js";
import { Orchestrator } from "./orchestrator.js";
import { AutonomyModeSchema, Incident, IncidentTypeSchema } from "./types.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: { sub: string };
  }
}

const isProd = process.env.NODE_ENV === "production";

function safeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  // Always run comparison to prevent timing leaks on length mismatch
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

interface LockState {
  failCount: number;
  lockoutUntil: number | null;
  // 0 = no prior lockout, 1 = had one 30m lockout (next lock is 24h)
  lockoutTier: number;
}

const MAX_ATTEMPTS = 5;
const LOCK_TIER1_MS = 30 * 60 * 1000;  // 30 minutes
const LOCK_TIER2_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function buildApp(options?: { contractsDir?: string; mode?: string }) {
  const mode = AutonomyModeSchema.parse(options?.mode ?? process.env.MAXIMAL_MODE ?? "observe");
  const contracts = new ContractRegistry();
  await contracts.load(options?.contractsDir ?? process.env.CONTRACTS_DIR ?? path.resolve("contracts"));
  const incidents = new IncidentRepository();
  const contexts = new ContextGraph();
  const audit = new AuditStore();
  const verifier = new DeterministicVerifier();
  const adapter = new MockAwsAdapter();
  const actions = createActionRegistry(adapter);
  const orchestrator = new Orchestrator(incidents, contracts, contexts, actions, audit, verifier, mode);
  const app = Fastify({ logger: true });

  // Auth — only enabled when MAXIMAL_JWT_SECRET is set (backward-compatible)
  const jwtSecret = process.env.MAXIMAL_JWT_SECRET;
  const authEnabled = Boolean(jwtSecret);
  const operatorUsername = process.env.MAXIMAL_OPERATOR_USERNAME ?? "admin";
  const operatorPassword = process.env.MAXIMAL_OPERATOR_PASSWORD ?? "changeme";

  const lockState = new Map<string, LockState>();
  function getLock(username: string): LockState {
    if (!lockState.has(username)) {
      lockState.set(username, { failCount: 0, lockoutUntil: null, lockoutTier: 0 });
    }
    return lockState.get(username)!;
  }

  // CORS — restrict origins in production via MAXIMAL_ALLOWED_ORIGINS
  await app.register(fastifyCors, {
    origin:
      process.env.MAXIMAL_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()) ??
      (isProd ? false : true),
    credentials: true
  });

  // Rate limiting — 120 req/min per IP globally
  await app.register(fastifyRateLimit, {
    max: 120,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({ error: "Too many requests" })
  });

  if (authEnabled) {
    await app.register(fastifyJwt, { secret: jwtSecret! });
  }

  // Security + cache headers on every response
  app.addHook("onSend", async (request, _reply, payload) => {
    const url = request.url;
    _reply.header("x-content-type-options", "nosniff");
    _reply.header("x-frame-options", "DENY");
    _reply.header("referrer-policy", "strict-origin-when-cross-origin");
    if (url.startsWith("/assets/")) {
      _reply.header("cache-control", "public, max-age=31536000, immutable");
    } else if (url === "/" || url.endsWith(".html")) {
      _reply.header("cache-control", "no-cache, no-store");
    }
    if (isProd) {
      _reply.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"
      );
      _reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authEnabled) return;
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  };

  const getActorId = (request: FastifyRequest): string => {
    if (authEnabled) return (request.user as { sub: string }).sub;
    const parsed = z
      .object({ actorId: z.string().min(1).default("local-operator") })
      .safeParse(request.body ?? {});
    return parsed.success ? parsed.data.actorId : "local-operator";
  };

  await app.register(fastifyStatic, {
    root: path.resolve("public"),
    prefix: "/"
  });

  // Auth endpoints
  app.post("/api/auth/login", async (request, reply) => {
    if (!authEnabled) {
      return reply.code(501).send({ error: "Authentication not enabled on this server" });
    }
    const bodyResult = z
      .object({ username: z.string().min(1), password: z.string().min(1) })
      .safeParse(request.body);
    if (!bodyResult.success) return reply.code(400).send({ error: "Invalid request" });

    const { username, password } = bodyResult.data;
    const lock = getLock(username);
    const now = Date.now();

    if (lock.lockoutUntil !== null && now < lock.lockoutUntil) {
      const secsRemaining = Math.ceil((lock.lockoutUntil - now) / 1000);
      const minsRemaining = Math.ceil(secsRemaining / 60);
      const msg = secsRemaining < 90
        ? `Account locked. Try again in ${secsRemaining}s.`
        : `Account locked. Try again in ${minsRemaining}m.`;
      return reply.code(429).send({ error: msg });
    }

    // Lockout window just expired — clear it but keep the tier so the next
    // failure batch escalates to the longer duration
    if (lock.lockoutUntil !== null && now >= lock.lockoutUntil) {
      lock.lockoutUntil = null;
    }

    const valid =
      safeStringEqual(username, operatorUsername) &&
      safeStringEqual(password, operatorPassword);

    if (!valid) {
      lock.failCount++;
      if (lock.failCount >= MAX_ATTEMPTS) {
        lock.failCount = 0;
        const isEscalated = lock.lockoutTier >= 1;
        lock.lockoutUntil = now + (isEscalated ? LOCK_TIER2_MS : LOCK_TIER1_MS);
        lock.lockoutTier = isEscalated ? 2 : 1;
      }
      // Constant-time delay to slow brute-force
      await new Promise((r) => setTimeout(r, 350));
      const attemptsLeft = MAX_ATTEMPTS - lock.failCount;
      const warnMsg = lock.lockoutUntil !== null
        ? lock.lockoutTier >= 2
          ? "Account locked for 24 hours."
          : "Account locked for 30 minutes."
        : `Invalid credentials. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} remaining.`;
      return reply.code(401).send({ error: warnMsg });
    }

    // Success — clear all lock state
    lockState.delete(username);
    const token = app.jwt.sign({ sub: username }, { expiresIn: "24h" });
    return reply.send({ token });
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    // Token invalidation is client-side; this endpoint exists for completeness
    return reply.send({ ok: true });
  });

  // Read endpoints — no auth required (health check used by ALB)
  app.get("/api/health", async () => ({
    ok: true,
    mode,
    contractCount: contracts.contracts.size,
    auditChainValid: audit.verifyChain(),
    registeredActions: actions.list(),
    authEnabled
  }));

  app.get("/api/contracts", async () => [...contracts.contracts.values()]);

  app.get("/api/incidents", async () =>
    incidents.list().map((incident) => ({
      ...incident,
      plan: orchestrator.plans.get(incident.id) ?? null
    }))
  );

  app.get("/api/incidents/:id/replay", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return { valid: audit.verifyChain(), records: audit.replay(id) };
  });

  // Write endpoints — auth-gated when MAXIMAL_JWT_SECRET is set
  app.post(
    "/api/incidents/demo",
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = z
        .object({
          type: IncidentTypeSchema.default("post_deploy_5xx_spike"),
          confidence: z.number().min(0).max(1).default(0.97),
          environment: z.string().default("staging")
        })
        .parse(request.body ?? {});
      const contract = contracts.contracts.get(body.type);
      if (!contract)
        return reply.code(400).send({ error: "No bundled contract for that incident type" });
      const detectService =
        typeof contract.detect.service === "string" ? contract.detect.service : "demo-service";
      const service = detectService;
      const isLambda = body.type.startsWith("lambda_");
      const proposedAction = isLambda ? "rollback_lambda_alias" : "rollback_ecs_task_definition";
      const metricResource = isLambda
        ? `arn:aws:lambda:us-east-1:123456789012:function:${service}`
        : "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/maximal-demo/abc123";
      const metricExcerpt = isLambda
        ? [
            "2026-06-25T06:52:00Z  Invocations=1,284  Errors=91  ErrorRate=7.09%",
            "2026-06-25T06:53:00Z  Invocations=1,301  Errors=96  ErrorRate=7.38%",
            "baseline (previous 30m) ErrorRate=0.42%"
          ].join("\n")
        : [
            "2026-06-25T06:52:00Z  RequestCount=8,421  HTTPCode_Target_5XX_Count=404  rate=4.80%",
            "2026-06-25T06:53:00Z  RequestCount=8,605  HTTPCode_Target_5XX_Count=431  rate=5.01%",
            "contract threshold: >2.00% for 5m"
          ].join("\n");
      const deployExcerpt = isLambda
        ? [
            "eventName: UpdateAlias",
            `requestParameters.functionName: ${service}`,
            "requestParameters.name: live",
            "requestParameters.functionVersion: 42",
            "previousKnownGoodVersion: 41"
          ].join("\n")
        : [
            "eventName: UpdateService",
            "requestParameters.cluster: maximal-demo",
            `requestParameters.service: ${service}`,
            "requestParameters.taskDefinition: task-def:42",
            "previousKnownGoodTaskDefinition: task-def:41"
          ].join("\n");
      const incident: Incident = {
        id: randomUUID(),
        type: body.type,
        service,
        environment: body.environment,
        source: "self_detect",
        confidence: body.confidence,
        evidence: [
          {
            kind: "metric",
            ref: `cloudwatch://${service}/${body.type}`,
            summary: `Synthetic ${body.type} threshold breached`,
            value: 4.8,
            observedAt: new Date().toISOString(),
            location: {
              resource: metricResource,
              source: isLambda
                ? "CloudWatch / AWS-Lambda / Errors + Invocations"
                : "CloudWatch / AWS-ApplicationELB / Target 5XX",
              selector: isLambda
                ? `FunctionName=${service} · 1 minute periods`
                : "TargetGroup=maximal-demo/abc123 · 1 minute periods"
            },
            excerpt: metricExcerpt,
            interpretation: isLambda
              ? "The function error rate rose to more than 7%, over 16× its trailing baseline, immediately after the alias shift."
              : "Target-generated 5XX responses remained above the contract's 2% threshold for consecutive periods.",
            remediation: {
              actionType: proposedAction,
              explanation: isLambda
                ? "Moving the live alias from version 42 back to known-good version 41 removes the version correlated with the error spike without changing the function configuration."
                : "Restoring task definition 41 removes the newly deployed container revision correlated with the target failures while preserving the service, load balancer, and desired count."
            }
          },
          {
            kind: "deploy_event",
            ref: `deploy://${service}/latest`,
            summary: "Recent deployment correlated with the regression",
            observedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
            location: {
              resource: isLambda
                ? `arn:aws:lambda:us-east-1:123456789012:function:${service}:live`
                : `arn:aws:ecs:us-east-1:123456789012:service/maximal-demo/${service}`,
              source: "CloudTrail / Management events",
              selector: isLambda
                ? "UpdateAlias · event ID evt-lambda-42"
                : "UpdateService · event ID evt-ecs-42"
            },
            excerpt: deployExcerpt,
            interpretation:
              "The production routing target changed eight minutes before the health regression, and no other scoped write occurred in the correlation window.",
            remediation: {
              actionType: proposedAction,
              explanation: isLambda
                ? "The rollback updates only the live alias to the snapshotted previous version, directly reversing this CloudTrail change."
                : "The rollback updates only this ECS service to the snapshotted previous task definition, directly reversing this CloudTrail change."
            }
          }
        ],
        deployCorrelation: {
          deployId: `deploy-${Date.now()}`,
          deployedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
          artifactRef: isLambda ? "lambda-version:42" : "task-def:42"
        },
        state: "DETECTED",
        createdAt: new Date().toISOString()
      };
      incidents.create(incident);
      contexts.upsert({
        service,
        environment: body.environment,
        dependencies: [],
        allowedActions: contract.allowed_actions,
        resources: isLambda
          ? { lambda: { functionName: service, alias: "live" } }
          : { ecs: { cluster: "maximal-demo", service } }
      });
      audit.append({
        incidentId: incident.id,
        actor: "system",
        actorId: null,
        eventType: "signal",
        payload: { source: incident.source, evidence: incident.evidence }
      });
      return reply.code(201).send(incident);
    }
  );

  app.post(
    "/api/incidents/:id/plan",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      try {
        return orchestrator.plan(id);
      } catch (error) {
        return reply.code(409).send({
          error: isProd ? "Planning failed" : (error instanceof Error ? error.message : "Planning failed")
        });
      }
    }
  );

  app.post(
    "/api/incidents/:id/approve",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actorId = getActorId(request);
      try {
        return await orchestrator.approve(id, actorId);
      } catch (error) {
        return reply.code(409).send({
          error: isProd ? "Approval failed" : (error instanceof Error ? error.message : "Approval failed")
        });
      }
    }
  );

  app.post(
    "/api/incidents/:id/deny",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actorId = getActorId(request);
      try {
        return orchestrator.deny(id, actorId);
      } catch (error) {
        return reply.code(409).send({
          error: isProd ? "Denial failed" : (error instanceof Error ? error.message : "Denial failed")
        });
      }
    }
  );

  app.post(
    "/api/incidents/:id/simulate-verification-failure",
    { preHandler: requireAuth },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      verifier.failNext(id);
      return { ok: true };
    }
  );

  return { app, orchestrator, adapter };
}
