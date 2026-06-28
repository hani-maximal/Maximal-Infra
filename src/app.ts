import path from "node:path";
import { randomUUID, timingSafeEqual, scrypt, randomBytes } from "node:crypto";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyJwt from "@fastify/jwt";
import { z } from "zod";
import { createActionRegistry, AwsAdapter, MockAwsAdapter } from "./actions.js";
import { getGitHubAdapter } from "./github.js";
import {
  AuditStore,
  ContextGraph,
  ContractRegistry,
  DeterministicVerifier,
  IncidentRepository
} from "./core.js";
import { Orchestrator } from "./orchestrator.js";
import { TenantRegistry } from "./tenant.js";
import { HttpHealthDetector } from "./detectors/http-health.js";
import { createSlackApp, SlackNotifier } from "./slack.js";
import { AutonomyModeSchema, Incident, IncidentTypeSchema } from "./types.js";
import { getRedis } from "./cache/client.js";
import { CacheKeys, TTL } from "./cache/keys.js";
import { getDb } from "./db/client.js";
import { getAppDb } from "./db/app-client.js";
import { appTenants, users, connectors } from "./db/app-schema.js";
import { calibrationRecords, proposedContractUpdates, trustConfigs } from "./db/schema.js";
import { eq, desc, and } from "drizzle-orm";
import { startWorkers } from "./learning/workers.js";
import { closeQueues } from "./queue/client.js";
import { upsertTrustConfig, deleteTrustConfig } from "./trust.js";
import { AutomationDepthSchema } from "./types.js";
import { getTenantTier, getLimits, tierAtLeast, clampModeToTier, type SubscriptionTier } from "./subscription.js";
import { onIncidentUpdated, subscribeToRedisChannel, subscribeToContractReloads, publishContractReload } from "./events.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: { sub: string; tenantId?: string };
  }
}

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

// ── Password helpers (Node built-in crypto, no bcrypt dep) ───────────────────

function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString("hex");
    scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(`${salt}:${key.toString("hex")}`);
    });
  });
}

function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [salt, key] = stored.split(":");
    if (!salt || !key) return resolve(false);
    scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve(timingSafeEqual(Buffer.from(key, "hex"), derived));
    });
  });
}

const isProd = process.env.NODE_ENV === "production";

function authCookieHeader(token: string): string {
  const base = `maximal_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`;
  return isProd ? `${base}; Secure` : base;
}

function clearCookieHeader(): string {
  const base = `maximal_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  return isProd ? `${base}; Secure` : base;
}

function parseCookieToken(cookieHeader: string): string | undefined {
  for (const segment of cookieHeader.split(";")) {
    const eqIdx = segment.indexOf("=");
    if (eqIdx === -1) continue;
    if (segment.slice(0, eqIdx).trim() === "maximal_token") {
      return decodeURIComponent(segment.slice(eqIdx + 1).trim()) || undefined;
    }
  }
  return undefined;
}

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
  let mode = AutonomyModeSchema.parse(options?.mode ?? process.env.MAXIMAL_MODE ?? "observe");
  const contractsDir = options?.contractsDir ?? process.env.CONTRACTS_DIR ?? path.resolve("contracts");
  const contracts = new ContractRegistry();
  await contracts.load(contractsDir);
  const incidents = new IncidentRepository();
  const contexts = new ContextGraph();
  const audit = new AuditStore();
  const verifier = new DeterministicVerifier();
  const awsConfigured =
    !process.env.VITEST &&
    Boolean(
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_PROFILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
    );
  const adapter = awsConfigured
    ? new AwsAdapter(process.env.AWS_REGION ?? "us-east-1")
    : new MockAwsAdapter();
  if (awsConfigured) {
    console.info(`[maximal] AWS adapter active — region: ${process.env.AWS_REGION ?? "us-east-1"}`);
  } else {
    console.info("[maximal] Mock AWS adapter active (set AWS_ACCESS_KEY_ID or AWS_PROFILE to use real AWS)");
  }
  const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID ?? "00000000-0000-4000-8000-000000000001";

  // Enforce subscription tier against the requested mode. A starter tenant
  // must not run in bounded_auto even if MAXIMAL_MODE says otherwise.
  const tenantTier = await getTenantTier(DEFAULT_TENANT_ID);
  const clampedMode = clampModeToTier(mode, tenantTier);
  if (clampedMode !== mode) {
    console.warn(
      `[maximal] MAXIMAL_MODE=${mode} exceeds ${tenantTier} plan — downgraded to ${clampedMode}`
    );
    mode = clampedMode;
  }

  // Wire up write-through DB for incident repository and audit store.
  const db = getDb();
  if (db) {
    incidents.setDb(db, DEFAULT_TENANT_ID);
    audit.setDb(db, DEFAULT_TENANT_ID);
    await incidents.loadFromDb().catch((err: unknown) => {
      console.warn("[maximal] Failed to load incidents from DB (continuing with empty cache):", err instanceof Error ? err.message : err);
    });
  }

  const github = getGitHubAdapter();
  const actions = createActionRegistry(adapter, github ?? undefined);
  const orchestrator = new Orchestrator(incidents, contracts, contexts, actions, audit, verifier, mode, DEFAULT_TENANT_ID);

  // Per-tenant registry — default tenant's bundle pre-registered for backward compat.
  const tenantRegistry = new TenantRegistry(actions, mode, contractsDir, github ?? undefined, getAppDb());
  tenantRegistry.register(DEFAULT_TENANT_ID, { orchestrator, contracts, incidents, audit, contexts });
  const getBundle = (tenantId: string) => tenantRegistry.getOrCreate(tenantId, contracts);

  // Slack — activated only when all three tokens are present
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN;
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  let slack: SlackNotifier | null = null;
  let slackApp: ReturnType<typeof createSlackApp> | null = null;
  if (slackBotToken && slackAppToken && slackSigningSecret) {
    slackApp = createSlackApp(slackBotToken, slackSigningSecret, slackAppToken);
    slack = new SlackNotifier(slackApp, orchestrator);
  }

  const app = Fastify({ logger: true, trustProxy: true });

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

  // Rate limiting — 120 req/min per IP globally.
  // Uses Redis store when available (cluster-safe, survives restarts).
  // Falls back to in-memory when Redis is not configured (local dev).
  const redis = getRedis();
  await app.register(fastifyRateLimit, {
    max: 120,
    timeWindow: "1 minute",
    ...(redis ? { redis } : {}),
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () => ({ error: "Too many requests" })
  });

  if (authEnabled) {
    await app.register(fastifyJwt, { secret: jwtSecret! });
  }

  // Default tenantId for every request (overridden by requireAuth when JWT is present).
  app.addHook("onRequest", async (request) => {
    request.tenantId = DEFAULT_TENANT_ID;
  });

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
    const cookieToken = parseCookieToken(request.headers.cookie ?? "");
    const authHeader = request.headers.authorization ?? "";
    const rawToken = cookieToken ?? (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "");
    if (!rawToken) return reply.code(401).send({ error: "Unauthorized" });
    try {
      const decoded = app.jwt.verify<{ sub: string; tenantId?: string; iat?: number }>(rawToken);
      request.user = { sub: decoded.sub, ...(decoded.tenantId !== undefined ? { tenantId: decoded.tenantId } : {}) };
      request.tenantId = decoded.tenantId ?? DEFAULT_TENANT_ID;
      const redis = getRedis();
      if (redis) {
        const jtiKey = `${decoded.sub}:${decoded.iat ?? 0}`;
        const score = await redis.zscore(CacheKeys.jwtRevoked(request.tenantId), jtiKey);
        if (score !== null) return reply.code(401).send({ error: "Token has been revoked" });
      }
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

    // Try app DB first (multi-tenant: email/password login)
    const appDb = getAppDb();
    let loginTenantId: string = DEFAULT_TENANT_ID;
    let loginUserId: string = username;
    let valid = false;

    if (appDb) {
      const [user] = await appDb
        .select()
        .from(users)
        .where(eq(users.email, username))
        .limit(1);
      if (user) {
        valid = await verifyPassword(password, user.passwordHash).catch(() => false);
        if (valid) {
          loginTenantId = user.tenantId;
          loginUserId = user.id;
        }
      }
    } else {
      // Single-tenant fallback: compare against env-var credentials
      valid =
        safeStringEqual(username, operatorUsername) &&
        safeStringEqual(password, operatorPassword);
    }

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
      const warnMsg = lock.lockoutUntil !== null
        ? lock.lockoutTier >= 2
          ? "Account locked for 24 hours."
          : "Account locked for 30 minutes."
        : "Invalid credentials.";
      return reply.code(401).send({ error: warnMsg });
    }

    // Success — clear all lock state
    lockState.delete(username);
    const token = app.jwt.sign({ sub: loginUserId, tenantId: loginTenantId }, { expiresIn: "24h" });
    reply.header("Set-Cookie", authCookieHeader(token));
    return reply.send({ token });
  });

  // POST /api/auth/register — create a new tenant + operator account.
  // On success returns a JWT so the caller is immediately logged in.
  // Requires MAXIMAL_JWT_SECRET to be set (no registration on unauthenticated servers).
  app.post("/api/auth/register", async (request, reply) => {
    if (!authEnabled) {
      return reply.code(501).send({ error: "Authentication not enabled on this server" });
    }
    const appDb = getAppDb();
    if (!appDb) {
      return reply.code(503).send({ error: "App database not configured (set APP_DATABASE_URL)" });
    }
    const bodyResult = z
      .object({
        email: z.string().email().max(255),
        password: z.string().min(8).max(128),
        organizationName: z.string().min(1).max(120),
      })
      .safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({ error: "Invalid request", detail: bodyResult.error.issues[0]?.message });
    }
    const { email, password, organizationName } = bodyResult.data;

    // Duplicate check
    const existing = await appDb.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      return reply.code(409).send({ error: "Registration failed. If you already have an account, please sign in." });
    }

    const passwordHash = await hashPassword(password);
    const tenantRows = await appDb
      .insert(appTenants)
      .values({ name: organizationName, subscriptionTier: "team" })
      .returning({ id: appTenants.id });
    const tenant = tenantRows[0];
    if (!tenant) throw new Error("Failed to create tenant");
    const userRows = await appDb
      .insert(users)
      .values({ email, passwordHash, role: "admin", tenantId: tenant.id })
      .returning({ id: users.id });
    const user = userRows[0];
    if (!user) throw new Error("Failed to create user");

    const token = app.jwt.sign({ sub: user.id, tenantId: tenant.id }, { expiresIn: "24h" });
    reply.header("Set-Cookie", authCookieHeader(token));
    return reply.code(201).send({ token, tenantId: tenant.id });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    reply.header("Set-Cookie", clearCookieHeader());
    if (authEnabled) {
      try {
        const cookieToken = parseCookieToken(request.headers.cookie ?? "");
        const rawToken = cookieToken ?? (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        const decoded = rawToken
          ? app.jwt.decode<{ sub: string; tenantId?: string; iat?: number; exp?: number }>(rawToken)
          : null;
        if (decoded) {
          const redis = getRedis();
          if (redis) {
            const jtiKey = `${decoded.sub}:${decoded.iat ?? 0}`;
            const ttlSecs = decoded.exp
              ? Math.max(1, decoded.exp - Math.floor(Date.now() / 1000))
              : TTL.jwtRevoked;
            const logoutTenantId = decoded.tenantId ?? DEFAULT_TENANT_ID;
            await redis.zadd(
              CacheKeys.jwtRevoked(logoutTenantId),
              decoded.exp ?? Date.now() / 1000 + TTL.jwtRevoked,
              jtiKey
            );
            await redis.expire(CacheKeys.jwtRevoked(logoutTenantId), ttlSecs);
          }
        }
      } catch {
        // Revocation failure is non-fatal
      }
    }
    return reply.send({ ok: true });
  });

  // GET /api/auth/me — returns identity from cookie or Authorization header.
  // Used by the client on startup to restore session state without exposing the
  // token to JavaScript. Returns 200 when auth is disabled (local-operator mode).
  app.get("/api/auth/me", { preHandler: requireAuth }, async (request) => {
    if (!authEnabled) {
      return { userId: "local-operator", tenantId: DEFAULT_TENANT_ID, authEnabled: false };
    }
    const user = request.user as { sub: string; tenantId?: string };
    return { userId: user.sub, tenantId: request.tenantId, authEnabled: true };
  });

  // Read endpoints — no auth required (health check used by ALB)
  app.get("/api/health", async () => ({
    ok: true,
    mode,
    contractCount: contracts.contracts.size,
    auditChainValid: audit.verifyChain(),
    authEnabled,
  }));

  // GET /api/subscription — returns the tenant's current tier, feature limits,
  // and live usage (service count). Auth-gated so only logged-in operators see it.
  app.get("/api/subscription", { preHandler: requireAuth }, async (request) => {
    const tier = await getTenantTier(request.tenantId);
    const limits = getLimits(tier);
    const { incidents: tenantIncidents } = await getBundle(request.tenantId);
    const serviceCount = new Set(tenantIncidents.list().map((i) => i.service)).size;
    return { tier, limits, usage: { serviceCount } };
  });

  app.get("/api/contracts", { preHandler: requireAuth }, async (request) => {
    const { contracts: tenantContracts } = await getBundle(request.tenantId);
    return [...tenantContracts.contracts.values()];
  });

  app.get("/api/incidents", { preHandler: requireAuth }, async (request) => {
    const { incidents: tenantIncidents, orchestrator: tenantOrchestrator } = await getBundle(request.tenantId);
    return tenantIncidents.list().map((incident) => ({
      ...incident,
      plan: tenantOrchestrator.plans.get(incident.id) ?? null,
    }));
  });

  app.get("/api/incidents/:id/replay", { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { audit: tenantAudit } = await getBundle(request.tenantId);
    return { valid: tenantAudit.verifyChain(), records: tenantAudit.replay(id) };
  });

  // SSE — incident state-change broadcast for live UI badge updates.
  // No auth required: payload is notification-only (no incident data),
  // and actual incident data still requires auth to fetch.
  app.get("/api/incidents/stream", (request, reply) => {
    const res = reply.raw;
    reply.hijack();
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable Nginx/ALB proxy buffering
    res.flushHeaders();

    const tenantId = request.tenantId;

    function send(eventName: string, data: unknown) {
      if (!res.writableEnded) {
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    }

    send("connected", { type: "connected" });

    const unsub = onIncidentUpdated((event) => {
      if (event.tenantId === tenantId) send("incident_updated", event);
    });

    // Heartbeat every 25s prevents proxies from closing idle SSE connections.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(":heartbeat\n\n");
    }, 25_000);

    res.on("close", () => {
      clearInterval(heartbeat);
      unsub();
    });
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
      const { contracts, incidents, contexts, audit } = await getBundle(request.tenantId);
      const contract = contracts.contracts.get(body.type);
      if (!contract)
        return reply.code(400).send({ error: "No bundled contract for that incident type" });

      const detectService =
        typeof contract.detect.service === "string" ? contract.detect.service : "demo-service";
      const service = detectService;

      const demoTier = await getTenantTier(request.tenantId);
      const demoLimits = getLimits(demoTier);
      if (demoLimits.maxServices !== null) {
        const existingServiceCount = new Set(incidents.list().map((i) => i.service)).size;
        const wouldBeNew = !incidents.list().some((i) => i.service === service);
        if (wouldBeNew && existingServiceCount >= demoLimits.maxServices) {
          return reply.code(402).send({
            error: `Starter plan is limited to ${demoLimits.maxServices} monitored services. Upgrade to Team or higher to add more.`,
            currentTier: demoTier,
            requiredTier: "team" as SubscriptionTier,
          });
        }
      }
      const isLambda = body.type.startsWith("lambda_");
      const isEc2 = body.type.startsWith("ec2_");
      const DEMO_INSTANCE_ID = "i-0demo1234567890ab";
      const DEMO_REGION = "us-east-1";
      const proposedAction = isLambda
        ? "rollback_lambda_alias"
        : isEc2
          ? "restart_ec2_instance"
          : "rollback_ecs_task_definition";
      const now = Date.now();
      const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
      const incidentId = randomUUID();
      const deployId = `${service}-${body.environment}-20260626-0542`;
      const traceId = `trace-${incidentId.slice(0, 8)}`;
      const ecsCluster = body.environment === "production" ? "maximal-prod" : "maximal-staging";
      const targetGroupArn =
        "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/prod-auth-api/8f3c1a2b4d5e6f70";

      const buildEvidence = (): Incident["evidence"] => {
        if (isLambda) {
          return [
            {
              kind: "metric",
              ref: `cloudwatch://${service}/${body.type}`,
              summary: `Lambda error rate exceeded threshold after version shift`,
              value: 7.2,
              observedAt: new Date().toISOString(),
              location: {
                resource: `arn:aws:lambda:us-east-1:123456789012:function:${service}`,
                source: "CloudWatch / AWS-Lambda / Errors + Invocations",
                selector: `FunctionName=${service} · 1 minute periods`
              },
              excerpt: [
                "2026-06-25T06:52:00Z  Invocations=1,284  Errors=91  ErrorRate=7.09%",
                "2026-06-25T06:53:00Z  Invocations=1,301  Errors=96  ErrorRate=7.38%",
                "baseline (previous 30m) ErrorRate=0.42%"
              ].join("\n"),
              interpretation: "The function error rate rose to more than 7%, over 16× its trailing baseline, immediately after the alias shift.",
              remediation: { actionType: proposedAction, explanation: "Moving the live alias from version 42 back to known-good version 41 removes the version correlated with the error spike without changing the function configuration." }
            },
            {
              kind: "deploy_event",
              ref: `deploy://${service}/latest`,
              summary: "UpdateAlias to version 42 correlated with the regression",
              observedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
              location: {
                resource: `arn:aws:lambda:us-east-1:123456789012:function:${service}:live`,
                source: "CloudTrail / Management events",
                selector: "UpdateAlias · event ID evt-lambda-42"
              },
              excerpt: ["eventName: UpdateAlias", `requestParameters.functionName: ${service}`, "requestParameters.name: live", "requestParameters.functionVersion: 42", "previousKnownGoodVersion: 41"].join("\n"),
              interpretation: "The production routing target changed eight minutes before the health regression, and no other scoped write occurred in the correlation window.",
              remediation: { actionType: proposedAction, explanation: "The rollback updates only the live alias to the snapshotted previous version, directly reversing this CloudTrail change." }
            }
          ];
        }
        if (isEc2) {
          return [
            {
              kind: "metric",
              ref: `http-probe://${service}/status`,
              summary: `${service} unreachable — no response for 3 consecutive health checks`,
              value: 8000,
              observedAt: new Date().toISOString(),
              location: {
                resource: `https://${service}`,
                source: "Maximal HTTP health probe",
                selector: `3 consecutive checks · 8000ms last response`
              },
              excerpt: [`target:    https://${service}`, "status:    connection refused", "latency:   8000ms", "failures:  3 consecutive", "threshold: 3 failures", `instance:  ${DEMO_INSTANCE_ID} (${DEMO_REGION})`].join("\n"),
              interpretation: `${service} has been unreachable for 3 consecutive probes. The EC2 instance may be stopped, crashed, or the process may have exited.`,
              remediation: { actionType: proposedAction, explanation: `Starting EC2 instance ${DEMO_INSTANCE_ID} (${DEMO_REGION}) will restore service if the instance was stopped or requires a reboot.` }
            },
            {
              kind: "alarm",
              ref: `cloudwatch://alarm/${service}/StatusCheckFailed`,
              summary: `EC2 StatusCheckFailed alarm ALARM for ${DEMO_INSTANCE_ID}`,
              observedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
              location: {
                resource: `arn:aws:ec2:${DEMO_REGION}:123456789012:instance/${DEMO_INSTANCE_ID}`,
                source: "CloudWatch / AWS-EC2 / StatusCheckFailed",
                selector: `InstanceId=${DEMO_INSTANCE_ID} · 1 minute periods`
              },
              excerpt: [`AlarmName: ${service}/StatusCheckFailed`, `StateValue: ALARM`, `MetricName: StatusCheckFailed`, `Namespace: AWS/EC2`, `Period: 60`, `Statistic: Maximum`, `Threshold: 1`].join("\n"),
              interpretation: `CloudWatch EC2 status check confirms the instance-level failure aligns with the HTTP probe data.`,
              remediation: { actionType: proposedAction, explanation: `Instance restart will clear the status check failure if caused by a software crash or unresponsive OS.` }
            }
          ];
        }
        if (!isLambda && !isEc2) {
          return [
            {
              kind: "metric",
              ref: `cloudwatch://${service}/${body.type}`,
              summary: "ALB target 5XX rate breached rollback contract after deploy",
              value: 4.8,
              observedAt: at(1),
              location: {
                resource: targetGroupArn,
                source: "CloudWatch / AWS-ApplicationELB / Target 5XX",
                selector: "TargetGroup=prod-auth-api/8f3c1a2b4d5e6f70, LoadBalancer=app/prod-edge/9db21f"
              },
              excerpt: [
                `${at(5)}  RequestCount=8,421  HTTPCode_Target_5XX_Count=404  rate=4.80%`,
                `${at(4)}  RequestCount=8,605  HTTPCode_Target_5XX_Count=431  rate=5.01%`,
                `${at(3)}  RequestCount=8,312  HTTPCode_Target_5XX_Count=399  rate=4.80%`,
                "contract threshold: >2.00% for 5m",
                "baseline previous 30m: 0.18%"
              ].join("\n"),
              interpretation: "Target-generated 5XX responses exceeded the contract threshold for consecutive periods and rose more than 25x above baseline.",
              remediation: { actionType: proposedAction, explanation: "Restoring task definition 41 removes the newly deployed container revision correlated with the target failures while preserving the service, load balancer, and desired count." }
            },
            {
              kind: "deploy_event",
              ref: `deploy://${service}/latest`,
              summary: "ECS service updated to task definition 42 eight minutes before regression",
              observedAt: at(8),
              location: {
                resource: `arn:aws:ecs:us-east-1:123456789012:service/${ecsCluster}/${service}`,
                source: "CloudTrail / Management events",
                selector: `UpdateService eventId=evt-${incidentId.slice(0, 12)}`
              },
              excerpt: [
                "eventName: UpdateService",
                `requestParameters.cluster: ${ecsCluster}`,
                `requestParameters.service: ${service}`,
                "requestParameters.taskDefinition: arn:aws:ecs:us-east-1:123456789012:task-definition/auth-api:42",
                "previousKnownGoodTaskDefinition: arn:aws:ecs:us-east-1:123456789012:task-definition/auth-api:41",
                `deploymentId: ${deployId}`,
                "userIdentity.sessionContext.sessionIssuer.userName: github-actions-prod"
              ].join("\n"),
              interpretation: "The service task definition changed inside the contract correlation window, and no other scoped write occurred before the error-rate jump.",
              remediation: { actionType: proposedAction, explanation: "The rollback updates only this ECS service to the snapshotted previous task definition, directly reversing this CloudTrail change." }
            },
            {
              kind: "log",
              ref: `cloudwatch-logs://${service}/${traceId}`,
              summary: "Application logs show auth token parser exceptions on the new container revision",
              observedAt: at(2),
              location: {
                resource: `/aws/ecs/${ecsCluster}/${service}`,
                source: "CloudWatch Logs Insights",
                selector: `fields @timestamp, @message | filter trace_id="${traceId}"`
              },
              excerpt: [
                `${at(3)} ERROR request_id=req-7fb status=500 route=/v1/session/refresh task=auth-api:42 trace_id=${traceId}`,
                `${at(3)} Error: token audience maximal-web is not accepted by parser version 42`,
                `${at(2)} WARN rollback_candidate=true previous_task_definition=auth-api:41`
              ].join("\n"),
              interpretation: "The failing requests share the newly deployed task revision and a parser error absent from the previous baseline.",
              remediation: { actionType: proposedAction, explanation: "Rolling back to task definition 41 removes the parser revision producing the 500s while preserving desired count and target group membership." }
            },
            {
              kind: "alarm",
              ref: `cloudwatch://alarm/${service}/alb-target-5xx-high`,
              summary: "Pager policy alarm entered ALARM and opened an incident",
              observedAt: at(1),
              location: {
                resource: `arn:aws:cloudwatch:us-east-1:123456789012:alarm:${service}-target-5xx-high`,
                source: "CloudWatch Alarm",
                selector: "EvaluationPeriods=5, DatapointsToAlarm=3, Threshold=2"
              },
              excerpt: [
                `AlarmName: ${service}-target-5xx-high`,
                "State: OK -> ALARM",
                "Reason: 3 datapoints were greater than threshold 2.0",
                "NotificationTargets: pagerduty-prod, #prod-incidents"
              ].join("\n"),
              interpretation: "The page-triggering alarm independently confirms the metric breach used by the remediation contract.",
              remediation: { actionType: proposedAction, explanation: "The proposed rollback directly targets the deployment correlated with the alarm transition." }
            }
          ];
        }
        return [
          {
            kind: "metric",
            ref: `cloudwatch://${service}/${body.type}`,
            summary: `Synthetic ${body.type} threshold breached`,
            value: 4.8,
            observedAt: new Date().toISOString(),
            location: {
              resource: "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/maximal-demo/abc123",
              source: "CloudWatch / AWS-ApplicationELB / Target 5XX",
              selector: "TargetGroup=maximal-demo/abc123 · 1 minute periods"
            },
            excerpt: ["2026-06-25T06:52:00Z  RequestCount=8,421  HTTPCode_Target_5XX_Count=404  rate=4.80%", "2026-06-25T06:53:00Z  RequestCount=8,605  HTTPCode_Target_5XX_Count=431  rate=5.01%", "contract threshold: >2.00% for 5m"].join("\n"),
            interpretation: "Target-generated 5XX responses remained above the contract's 2% threshold for consecutive periods.",
            remediation: { actionType: proposedAction, explanation: "Restoring task definition 41 removes the newly deployed container revision correlated with the target failures while preserving the service, load balancer, and desired count." }
          },
          {
            kind: "deploy_event",
            ref: `deploy://${service}/latest`,
            summary: "Recent deployment correlated with the regression",
            observedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
            location: {
              resource: `arn:aws:ecs:us-east-1:123456789012:service/maximal-demo/${service}`,
              source: "CloudTrail / Management events",
              selector: "UpdateService · event ID evt-ecs-42"
            },
            excerpt: ["eventName: UpdateService", "requestParameters.cluster: maximal-demo", `requestParameters.service: ${service}`, "requestParameters.taskDefinition: task-def:42", "previousKnownGoodTaskDefinition: task-def:41"].join("\n"),
            interpretation: "The production routing target changed eight minutes before the health regression, and no other scoped write occurred in the correlation window.",
            remediation: { actionType: proposedAction, explanation: "The rollback updates only this ECS service to the snapshotted previous task definition, directly reversing this CloudTrail change." }
          }
        ];
      };

      const incident: Incident = {
        id: incidentId,
        type: body.type,
        service,
        environment: body.environment,
        source: "self_detect",
        confidence: body.confidence,
        evidence: buildEvidence(),
        deployCorrelation: isEc2
          ? null
          : {
              deployId,
              deployedAt: at(8),
              artifactRef: isLambda ? "lambda-version:42" : "task-def:42"
            },
        state: "DETECTED",
        createdAt: at(0)
      };
      incidents.create(incident);
      contexts.upsert({
        service,
        environment: body.environment,
        dependencies: [],
        allowedActions: contract.allowed_actions,
        resources: isLambda
          ? { lambda: { functionName: service, alias: "live" } }
          : isEc2
            ? { ec2: { instanceId: DEMO_INSTANCE_ID, region: DEMO_REGION } }
            : { ecs: { cluster: ecsCluster, service } }
      });
      audit.append({
        incidentId: incident.id,
        actor: "system",
        actorId: null,
        eventType: "signal",
        ts: at(1),
        payload: {
          detector: "maximal.self_detect.alb_5xx",
          source: incident.source,
          severity: body.environment === "production" ? "sev2" : "sev3",
          service: incident.service,
          environment: incident.environment,
          dedupeKey: `${incident.environment}:${incident.service}:${incident.type}:${deployId}`,
          evidenceRefs: incident.evidence.map((e) => e.ref)
        }
      });
      audit.append({
        incidentId: incident.id,
        actor: "system",
        actorId: null,
        eventType: "hypothesis",
        ts: at(0),
        payload: {
          primaryHypothesis: "new_task_definition_regression",
          confidence: incident.confidence,
          correlationWindowMinutes: 30,
          deployCorrelation: incident.deployCorrelation,
          proposedAction
        }
      });
      return reply.code(201).send(incident);
    }
  );

  app.post(
    "/api/incidents/:id/plan",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { orchestrator: tenantOrchestrator, incidents: tenantIncidents, contracts: tenantContracts } = await getBundle(request.tenantId);
      try {
        const plan = await tenantOrchestrator.plan(id);
        if (plan.policy.decision === "APPROVE" && slack) {
          const incident = tenantIncidents.get(id);
          const contract = incident ? tenantContracts.match(incident) : null;
          if (incident && contract) {
            slack.requestApproval(incident, plan, contract.notify.slack_channel).catch((err) => {
              app.log.error({ err }, "[slack] requestApproval failed");
            });
          }
        }
        return plan;
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
      const { orchestrator: tenantOrchestrator } = await getBundle(request.tenantId);
      try {
        const incident = await tenantOrchestrator.approve(id, actorId);
        if (slack) {
          slack.notifyOutcome(id, incident).catch((err) => {
            app.log.error({ err }, "[slack] notifyOutcome failed");
          });
        }
        return incident;
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
      const { orchestrator: tenantOrchestrator } = await getBundle(request.tenantId);
      try {
        const incident = await tenantOrchestrator.deny(id, actorId);
        if (slack) {
          slack.notifyOutcome(id, incident).catch((err) => {
            app.log.error({ err }, "[slack] notifyOutcome failed");
          });
        }
        return incident;
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

  // ---------------------------------------------------------------------------
  // Learning pipeline read endpoints (no auth — calibration and proposals are
  // advisory intelligence, not write-gated).
  // ---------------------------------------------------------------------------

  // GET /api/learning/calibration — confidence calibration records for a
  // given incident type. Used by the dashboard to show "confidence 0.93–0.96
  // resolved 72% of the time for lambda_error_spike".
  app.get("/api/learning/calibration", { preHandler: requireAuth }, async (request) => {
    const { type } = z
      .object({ type: z.string().optional() })
      .parse(request.query);
    const db = getDb();
    if (!db) return [];
    const tenantId = request.tenantId;
    const rows = type
      ? await db
          .select()
          .from(calibrationRecords)
          .where(eq(calibrationRecords.tenantId, tenantId))
          .orderBy(desc(calibrationRecords.computedAt))
          .limit(200)
      : await db
          .select()
          .from(calibrationRecords)
          .where(eq(calibrationRecords.tenantId, tenantId))
          .orderBy(desc(calibrationRecords.computedAt))
          .limit(200);
    return rows;
  });

  // GET /api/learning/proposals — pending contract update proposals from the
  // contract-learner pipeline. Operators review and approve/reject in the UI.
  app.get("/api/learning/proposals", { preHandler: requireAuth }, async (request) => {
    const { status } = z
      .object({ status: z.enum(["pending", "approved", "rejected"]).default("pending") })
      .parse(request.query);
    const db = getDb();
    if (!db) return [];
    const tenantId = request.tenantId;
    return db
      .select()
      .from(proposedContractUpdates)
      .where(eq(proposedContractUpdates.tenantId, tenantId))
      .orderBy(desc(proposedContractUpdates.createdAt))
      .limit(100);
  });

  // PATCH /api/learning/proposals/:id — approve or reject a proposal.
  // On approval: validates YAML, writes to S3, publishes contract reload signal.
  // On rejection: updates status only.
  app.patch(
    "/api/learning/proposals/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { status } = z
        .object({ status: z.enum(["approved", "rejected"]) })
        .parse(request.body);
      const actorId = getActorId(request);
      const db = getDb();
      if (!db) return reply.code(503).send({ error: "Database not configured" });

      if (status === "approved") {
        // 1. Fetch the proposal
        const [proposal] = await db
          .select()
          .from(proposedContractUpdates)
          .where(eq(proposedContractUpdates.id, id))
          .limit(1);
        if (!proposal) return reply.code(404).send({ error: "Proposal not found" });

        // 2. Parse and validate YAML against ContractSchema
        let validated;
        try {
          const { default: YAML } = await import("yaml");
          const { ContractSchema } = await import("./types.js");
          validated = ContractSchema.parse(YAML.parse(proposal.proposedYaml));
        } catch (err) {
          return reply.code(422).send({
            error: "Proposed YAML is not a valid contract",
            detail: err instanceof Error ? err.message : String(err),
          });
        }

        // 3. Write validated YAML to S3 (if configured)
        const bucket = process.env.CONTRACTS_BUCKET;
        if (bucket) {
          try {
            const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
            const { default: YAML } = await import("yaml");
            const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
            const key = `${request.tenantId}/${validated.incident_type}.yaml`;
            await s3.send(new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: YAML.stringify(validated),
              ContentType: "application/x-yaml",
            }));
            app.log.info({ key, bucket }, "[contracts] Wrote approved contract to S3");

            // 4. Publish reload signal → all instances hot-reload this tenant's contracts
            await publishContractReload(request.tenantId);
          } catch (err) {
            app.log.error({ err }, "[contracts] Failed to write approved contract to S3");
            return reply.code(502).send({ error: "Failed to persist contract to S3" });
          }
        } else {
          // S3 not configured — hot-reload in-memory for this tenant
          const { contracts: tenantContracts } = await getBundle(request.tenantId);
          tenantContracts.contracts.set(validated.incident_type, validated);
          app.log.info({ type: validated.incident_type }, "[contracts] Hot-loaded approved contract into in-memory registry (no S3)");
        }
      }

      await db
        .update(proposedContractUpdates)
        .set({ status, reviewedBy: actorId, reviewedAt: new Date() })
        .where(eq(proposedContractUpdates.id, id));
      return { ok: true };
    }
  );

  // ---------------------------------------------------------------------------
  // Trust config endpoints — per-tenant automation depth per incident type.
  // Controls whether known contracts require human approval and how novel
  // incidents are routed. Does NOT override safety invariants (ESCALATE,
  // snapshot+revert, blast radius hard limits).
  // ---------------------------------------------------------------------------

  // GET /api/trust-configs — list all configs for this tenant
  app.get("/api/trust-configs", { preHandler: requireAuth }, async (request) => {
    const db = getDb();
    if (!db) return [];
    const tenantId = request.tenantId;
    return db
      .select()
      .from(trustConfigs)
      .where(eq(trustConfigs.tenantId, tenantId))
      .orderBy(trustConfigs.incidentType);
  });

  // PUT /api/trust-configs — upsert a config (incidentType: null = tenant default).
  // Custom trust configs are a Scale-tier feature.
  app.put(
    "/api/trust-configs",
    { preHandler: requireAuth },
    async (request, reply) => {
      const tier = await getTenantTier(request.tenantId);
      if (!tierAtLeast(tier, "scale")) {
        return reply.code(402).send({
          error: "Custom trust configs require the Scale plan or higher.",
          currentTier: tier,
          requiredTier: "scale" as SubscriptionTier,
        });
      }
      const body = z
        .object({
          incidentType: z.string().nullable().default(null),
          automationDepth: AutomationDepthSchema,
          novelIncidentConfidenceThreshold: z.number().min(0).max(1).default(0.95),
          maxBlastRadiusOverride: z.number().int().positive().nullable().default(null),
          requiresApprovalOverride: z.boolean().nullable().default(null),
        })
        .parse(request.body);
      const db = getDb();
      if (!db) return reply.code(503).send({ error: "Database not configured" });
      await upsertTrustConfig(request.tenantId, body);
      return { ok: true };
    }
  );

  // DELETE /api/trust-configs — remove a config (body: { incidentType: string | null }).
  // Custom trust configs are a Scale-tier feature.
  app.delete(
    "/api/trust-configs",
    { preHandler: requireAuth },
    async (request, reply) => {
      const tier = await getTenantTier(request.tenantId);
      if (!tierAtLeast(tier, "scale")) {
        return reply.code(402).send({
          error: "Custom trust configs require the Scale plan or higher.",
          currentTier: tier,
          requiredTier: "scale" as SubscriptionTier,
        });
      }
      const { incidentType } = z
        .object({ incidentType: z.string().nullable().default(null) })
        .parse(request.body);
      const db = getDb();
      if (!db) return reply.code(503).send({ error: "Database not configured" });
      await deleteTrustConfig(request.tenantId, incidentType);
      return { ok: true };
    }
  );

  // ---------------------------------------------------------------------------
  // Connector CRUD — per-tenant AWS account connectors (IAM role or access key).
  // All endpoints require auth; connectors are scoped to the caller's tenant.
  // ---------------------------------------------------------------------------

  // GET /api/connectors — list connectors for the calling tenant.
  app.get("/api/connectors", { preHandler: requireAuth }, async (request) => {
    const appDb = getAppDb();
    if (!appDb) return [];
    return appDb
      .select({
        id: connectors.id,
        name: connectors.name,
        type: connectors.type,
        roleArn: connectors.roleArn,
        region: connectors.region,
        isActive: connectors.isActive,
        lastTestedAt: connectors.lastTestedAt,
        createdAt: connectors.createdAt,
      })
      .from(connectors)
      .where(eq(connectors.tenantId, request.tenantId))
      .orderBy(connectors.createdAt);
  });

  // POST /api/connectors — create a connector.
  app.post("/api/connectors", { preHandler: requireAuth }, async (request, reply) => {
    const appDb = getAppDb();
    if (!appDb) return reply.code(503).send({ error: "App database not configured" });
    const body = z
      .object({
        name: z.string().min(1).max(120),
        type: z.enum(["iam_role", "access_key"]),
        roleArn: z.string().optional(),
        externalId: z.string().optional(),
        region: z.string().default("us-east-1"),
        config: z.record(z.unknown()).optional(),
      })
      .parse(request.body);
    const [connector] = await appDb
      .insert(connectors)
      .values({
        tenantId: request.tenantId,
        name: body.name,
        type: body.type,
        roleArn: body.roleArn ?? null,
        externalId: body.externalId ?? null,
        region: body.region,
        config: body.config ?? null,
      })
      .returning({
        id: connectors.id,
        tenantId: connectors.tenantId,
        name: connectors.name,
        type: connectors.type,
        roleArn: connectors.roleArn,
        region: connectors.region,
        config: connectors.config,
        isActive: connectors.isActive,
        lastTestedAt: connectors.lastTestedAt,
        createdAt: connectors.createdAt,
      });
    // Evict cached bundle so next request picks up fresh connector credentials.
    tenantRegistry.evict(request.tenantId);
    return reply.code(201).send(connector);
  });

  // DELETE /api/connectors/:id — delete a connector (must belong to calling tenant).
  app.delete("/api/connectors/:id", { preHandler: requireAuth }, async (request, reply) => {
    const appDb = getAppDb();
    if (!appDb) return reply.code(503).send({ error: "App database not configured" });
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    // Scope to tenant — prevents cross-tenant deletion.
    const [existing] = await appDb
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.id, id), eq(connectors.tenantId, request.tenantId)))
      .limit(1);
    if (!existing) {
      return reply.code(404).send({ error: "Connector not found" });
    }
    await appDb.delete(connectors).where(and(eq(connectors.id, id), eq(connectors.tenantId, request.tenantId)));
    tenantRegistry.evict(request.tenantId);
    return { ok: true };
  });

  // PUT /api/connectors/:id/test — verify connectivity (assume-role or sts:GetCallerIdentity).
  // Sets lastTestedAt on success; returns error detail on failure.
  app.put("/api/connectors/:id/test", { preHandler: requireAuth }, async (request, reply) => {
    const appDb = getAppDb();
    if (!appDb) return reply.code(503).send({ error: "App database not configured" });
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [connector] = await appDb
      .select()
      .from(connectors)
      .where(eq(connectors.id, id))
      .limit(1);
    if (!connector || connector.tenantId !== request.tenantId) {
      return reply.code(404).send({ error: "Connector not found" });
    }
    try {
      const { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } = await import("@aws-sdk/client-sts");
      if (connector.type === "iam_role" && connector.roleArn) {
        // AssumeRole then GetCallerIdentity with the assumed credentials
        const sts = new STSClient({ region: connector.region });
        const assumed = await sts.send(new AssumeRoleCommand({
          RoleArn: connector.roleArn,
          RoleSessionName: "maximal-connector-test",
          DurationSeconds: 900,
          ...(connector.externalId ? { ExternalId: connector.externalId } : {}),
        }));
        if (assumed.Credentials) {
          const creds = assumed.Credentials;
          const assumedSts = new STSClient({
            region: connector.region,
            credentials: {
              accessKeyId: creds.AccessKeyId!,
              secretAccessKey: creds.SecretAccessKey!,
              ...(creds.SessionToken ? { sessionToken: creds.SessionToken } : {}),
            },
          });
          await assumedSts.send(new GetCallerIdentityCommand({}));
        }
      } else {
        const sts = new STSClient({ region: connector.region });
        await sts.send(new GetCallerIdentityCommand({}));
      }
      await appDb
        .update(connectors)
        .set({ lastTestedAt: new Date() })
        .where(eq(connectors.id, id));
      return { ok: true, testedAt: new Date().toISOString() };
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        error: "Connectivity test failed. Check that the IAM role ARN and trust policy are correct.",
      });
    }
  });

  // Slack Socket Mode lifecycle — start/stop alongside Fastify
  if (slackApp) {
    app.addHook("onReady", async () => {
      await slackApp!.start();
      app.log.info("[slack] Socket Mode connected");
    });
    app.addHook("onClose", async () => {
      await slackApp!.stop();
    });
  }

  // Learning pipeline workers — start alongside the API server.
  // Returns a shutdown fn or null (when Redis is not configured).
  let stopWorkers: (() => Promise<void>) | null = null;
  let stopRedisSubscription: (() => Promise<void>) | null = null;
  let stopContractReloadSubscription: (() => Promise<void>) | null = null;
  app.addHook("onReady", async () => {
    stopWorkers = startWorkers();
    stopRedisSubscription = await subscribeToRedisChannel();
    stopContractReloadSubscription = await subscribeToContractReloads(async (tenantId) => {
      await tenantRegistry.reloadContracts(tenantId);
      app.log.info({ tenantId }, "[contracts] Hot-reloaded from S3");
    });
  });
  app.addHook("onClose", async () => {
    if (stopWorkers) await stopWorkers();
    if (stopRedisSubscription) await stopRedisSubscription();
    if (stopContractReloadSubscription) await stopContractReloadSubscription();
    await closeQueues();
  });

  // HTTP health detector — activated by env vars, no-op otherwise
  const healthUrl = process.env.MAXIMAL_HEALTH_URL;
  if (healthUrl) {
    const detector = new HttpHealthDetector(
      {
        url: healthUrl,
        service: process.env.MAXIMAL_HEALTH_SERVICE ?? new URL(healthUrl).hostname,
        environment: process.env.MAXIMAL_HEALTH_ENV ?? "production",
        ...(process.env.MAXIMAL_HEALTH_INSTANCE_ID ? { instanceId: process.env.MAXIMAL_HEALTH_INSTANCE_ID } : {}),
        region: process.env.MAXIMAL_HEALTH_REGION ?? "us-east-1",
        pollIntervalMs: Number(process.env.MAXIMAL_HEALTH_INTERVAL_MS ?? 30_000),
        failureThreshold: Number(process.env.MAXIMAL_HEALTH_FAIL_THRESHOLD ?? 3)
      },
      incidents,
      contexts,
      audit
    );
    app.addHook("onReady", async () => detector.start());
    app.addHook("onClose", async () => detector.stop());
  }

  return { app, orchestrator, adapter };
}
