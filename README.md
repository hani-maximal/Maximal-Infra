# Maximal

Maximal is a safe-execution control plane for AWS remediation. It turns a diagnosis into a typed plan, evaluates it against a remediation contract, requires approval when policy demands it, captures a pre-action snapshot, executes through a closed action registry, verifies recovery, and reverts on failure.

This repository is safe by default:

- `MAXIMAL_MODE=observe` is the default.
- The included runtime uses a deterministic mock AWS adapter.
- There is no shell action, generic command action, or text-to-AWS path.
- Every action must be registered, contract-allowlisted, service-allowlisted, validated, and snapshotted.

## Run

```powershell
pnpm install
pnpm build:ui
pnpm test
pnpm start
```

Open `http://localhost:4310`.

## Frontend

The dashboard is built with React 19, MUI, Tailwind CSS 4, and Vite. Source files live under `ui/`; the production build is emitted to `public/` and served by Fastify.

## AWS deployment

The OpenTofu Fargate/ALB stack and deployment guide live in
[`infra/tofu`](infra/tofu/README.md). The current production deployment is
intentionally restricted to observe mode because the real AWS SDK execution
adapter has not been implemented yet.

## Modes

- `observe`: plans only; execution is blocked.
- `approve`: human approval is required for every write.
- `bounded_auto`: contracts may permit reversible actions within their blast radius.

Changing the mode does not enable real AWS writes. A production adapter must be added explicitly behind the same typed interface.

## API

- `GET /api/health`
- `GET /api/contracts`
- `GET /api/incidents`
- `POST /api/incidents/demo`
- `POST /api/incidents/:id/plan`
- `POST /api/incidents/:id/approve`
- `POST /api/incidents/:id/deny`
- `GET /api/incidents/:id/replay`
- `POST /api/incidents/:id/simulate-verification-failure`

The demo endpoint creates one of four MVP incidents: `post_deploy_5xx_spike`, `ecs_service_unhealthy`, `lambda_error_spike`, or `deploy_failed_or_stuck`.
