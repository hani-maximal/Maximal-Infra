import { useState } from "react";
import {
  Alert,
  Avatar,
  Box,
  Chip,
  Collapse,
  LinearProgress,
  Paper,
  Stack,
  Tab,
  Tabs,
  Typography
} from "@mui/material";
import {
  CheckCircleRounded,
  FactCheckOutlined
} from "@mui/icons-material";
import { ActionPanel } from "./ActionPanel.js";
import { EvidenceCard } from "./EvidenceCard.js";
import { AuditTimeline } from "./AuditTimeline.js";
import type { AuditRecord, Health, Incident } from "../types.js";
import { formatLabel } from "../utils.js";

const surface = {
  border: "1px solid rgba(212,230,220,.09)",
  bgcolor: "#111614",
  borderRadius: "16px"
};

const fmt = formatLabel;

// ── Lifecycle stepper ─────────────────────────────────────────────

type StepKind = "done" | "current" | "fail" | "todo";

interface Step {
  label: string;
  time: string | undefined;
  kind: StepKind;
}

const STATE_TO_IDX: Record<string, number> = {
  DETECTED: 0,
  CLASSIFIED: 1,
  CONTRACT_MATCHED: 2,
  AWAITING_APPROVAL: 3,
  EXECUTING: 4,
  VERIFYING: 5,
  RESOLVED: 6,
  CLOSED: 6
};

const REVERT_STATES = new Set(["ROLLING_BACK", "ROLLED_BACK", "ESCALATED"]);

function recTime(records: AuditRecord[], eventType: string): string | undefined {
  const r = records.find((r) => r.eventType === eventType);
  if (!r) return undefined;
  return new Date(r.ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function buildSteps(state: string, records: AuditRecord[]): Step[] {
  const isRevert = REVERT_STATES.has(state);
  const idx = STATE_TO_IDX[state] ?? 0;

  function k(stepIdx: number): StepKind {
    if (isRevert || idx > stepIdx) return "done";
    if (idx === stepIdx) return "current";
    return "todo";
  }

  const base: Step[] = [
    { label: "Detected", time: recTime(records, "signal"), kind: k(0) },
    { label: "Classified", time: recTime(records, "classification"), kind: k(1) },
    { label: "Contract matched", time: recTime(records, "contract_match"), kind: k(2) },
    { label: "Approved", time: recTime(records, "approval_granted"), kind: k(3) },
    { label: "Executed", time: recTime(records, "aws_action"), kind: k(4) }
  ];

  if (isRevert) {
    return [
      ...base,
      { label: "Verify failed", time: recTime(records, "verification"), kind: "fail" },
      {
        label: "Reverted",
        time: recTime(records, "rollback"),
        kind: state === "ROLLING_BACK" ? "current" : "done"
      },
      {
        label: "Escalated",
        time: recTime(records, "escalation"),
        kind: state === "ESCALATED" ? "current" : "todo"
      }
    ];
  }

  return [
    ...base,
    {
      label: "Verified",
      time: recTime(records, "verification"),
      kind: idx > 5 ? "done" : idx === 5 ? "current" : "todo"
    },
    {
      label: "Resolved",
      time: recTime(records, "state_change"),
      kind: idx >= 6 ? "current" : "todo"
    }
  ];
}

function StepDot({ kind }: { kind: StepKind }) {
  if (kind === "done") {
    return (
      <Box
        sx={{
          width: 24,
          height: 24,
          borderRadius: "50%",
          bgcolor: "primary.main",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#07100b",
          fontSize: 13,
          fontWeight: 800
        }}
      >
        ✓
      </Box>
    );
  }
  if (kind === "current") {
    return (
      <Box
        sx={{
          width: 24,
          height: 24,
          borderRadius: "50%",
          bgcolor: "rgba(114,227,163,.14)",
          border: "2px solid #72e3a3",
          animation: "maxpulse 2.2s infinite"
        }}
      />
    );
  }
  if (kind === "fail") {
    return (
      <Box
        sx={{
          width: 24,
          height: 24,
          borderRadius: "50%",
          bgcolor: "#ff8d8d",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#2a0d0d",
          fontSize: 13,
          fontWeight: 800
        }}
      >
        ✕
      </Box>
    );
  }
  return (
    <Box
      sx={{
        width: 24,
        height: 24,
        borderRadius: "50%",
        bgcolor: "#111614",
        border: "2px solid rgba(212,230,220,.18)"
      }}
    />
  );
}

function LifecycleStepper({ steps }: { steps: Step[] }) {
  return (
    <Box sx={{ mt: 3.25, position: "relative" }}>
      <Box
        sx={{
          position: "absolute",
          top: 11,
          left: 24,
          right: 24,
          height: 2,
          bgcolor: "rgba(212,230,220,.12)"
        }}
      />
      <Box sx={{ position: "relative", display: "flex", justifyContent: "space-between" }}>
        {steps.map((step) => (
          <Box
            key={step.label}
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              flex: 1,
              minWidth: 0
            }}
          >
            <Box sx={{ bgcolor: "#111614", px: 0.75 }}>
              <StepDot kind={step.kind} />
            </Box>
            <Typography
              sx={{
                mt: 1.1,
                fontSize: 11,
                fontWeight: 600,
                textAlign: "center",
                color: "#dfe7e2",
                lineHeight: 1.25
              }}
            >
              {step.label}
            </Typography>
            {step.time && (
              <Typography
                sx={{
                  mt: 0.25,
                  fontSize: 10,
                  color: "#6f827a",
                  fontFamily: "ui-monospace, Menlo, monospace"
                }}
              >
                {step.time}
              </Typography>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ── Snapshot card ─────────────────────────────────────────────────

interface SnapshotData {
  id: string;
  capturedAt: string;
}

function SnapshotCard({
  data,
  isReverted
}: {
  data: SnapshotData;
  isReverted: boolean;
}) {
  const captured = (() => {
    try {
      return new Date(data.capturedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
    } catch {
      return data.capturedAt;
    }
  })();

  return (
    <Box
      sx={{
        p: "17px 18px",
        borderRadius: "12px",
        bgcolor: "rgba(255,255,255,.018)",
        border: "1px solid rgba(212,230,220,.1)",
        display: "flex",
        flexDirection: "column",
        height: "100%"
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography sx={{ fontSize: 14, color: "#9abaff" }}>⬡</Typography>
        <Typography
          sx={{
            fontSize: 11,
            letterSpacing: ".1em",
            fontWeight: 700,
            color: "#9aafa5"
          }}
        >
          PRE-ACTION SNAPSHOT
        </Typography>
      </Stack>
      <Typography
        sx={{
          mt: 1.4,
          fontSize: 13.5,
          fontFamily: "ui-monospace, Menlo, monospace",
          color: "#f4f7f5"
        }}
      >
        {data.id.slice(0, 14)}
      </Typography>
      <Typography sx={{ mt: 0.625, fontSize: 12, color: "#9aafa5" }}>
        Captured{" "}
        <Typography
          component="span"
          sx={{ fontFamily: "ui-monospace, Menlo, monospace", color: "#cdd9d2", fontSize: "inherit" }}
        >
          {captured}
        </Typography>
      </Typography>
      <Box
        component="button"
        disabled
        sx={{
          mt: "auto",
          pt: 1.4,
          background: "transparent",
          border: "1px solid rgba(212,230,220,.18)",
          color: "#cdd9d2",
          borderRadius: "9px",
          px: 1.5,
          py: 1,
          fontSize: 12.5,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "not-allowed",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 0.875,
          opacity: 0.65
        }}
      >
        ⟲ {isReverted ? "Reverted automatically" : "Revert to snapshot"}
      </Box>
    </Box>
  );
}

// ── Verification panel ────────────────────────────────────────────

interface VerificationCheck {
  metric: string;
  condition: string;
  passed: boolean;
  observed: string;
}

function VerificationPanel({
  checks,
  ok
}: {
  checks: VerificationCheck[];
  ok: boolean;
}) {
  if (checks.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: "center" }}>
        Verification results will appear here after execution.
      </Typography>
    );
  }

  return (
    <Box sx={{ mt: 2.25 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
        <Typography sx={{ fontSize: 12, color: "#9aafa5" }}>
          Objective health checks · window{" "}
          <Typography
            component="span"
            sx={{ fontFamily: "ui-monospace, Menlo, monospace", color: "#cdd9d2", fontSize: "inherit" }}
          >
            10m
          </Typography>
        </Typography>
        {ok ? (
          <Chip
            label="ALL PASSED"
            size="small"
            sx={{
              height: 22,
              fontSize: 11,
              fontWeight: 700,
              color: "#72e3a3",
              bgcolor: "transparent",
              border: "1px solid rgba(114,227,163,.3)"
            }}
          />
        ) : (
          <Chip
            label="CHECK FAILED"
            size="small"
            sx={{
              height: 22,
              fontSize: 11,
              fontWeight: 700,
              color: "#ff8d8d",
              bgcolor: "transparent",
              border: "1px solid rgba(255,141,141,.32)"
            }}
          />
        )}
      </Stack>
      <Stack spacing={1.1}>
        {checks.map((check) => (
          <Box
            key={check.metric}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.75,
              px: 2,
              py: 1.75,
              borderRadius: "11px",
              bgcolor: "rgba(255,255,255,.014)",
              border: "1px solid rgba(212,230,220,.1)"
            }}
          >
            <Box
              sx={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                bgcolor: check.passed ? "rgba(114,227,163,.1)" : "rgba(255,141,141,.1)",
                color: check.passed ? "#72e3a3" : "#ff8d8d",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: check.passed ? 14 : 13,
                fontWeight: 800,
                flexShrink: 0
              }}
            >
              {check.passed ? "✓" : "✕"}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                sx={{
                  fontSize: 13.5,
                  fontWeight: 650,
                  fontFamily: "ui-monospace, Menlo, monospace"
                }}
              >
                {check.metric}
              </Typography>
              <Typography sx={{ fontSize: 12, color: "#9aafa5", mt: 0.375 }}>
                Target {check.condition}
              </Typography>
            </Box>
            <Box sx={{ textAlign: "right", flexShrink: 0 }}>
              <Typography sx={{ fontSize: 11, color: "#9aafa5" }}>Observed</Typography>
              <Typography
                sx={{
                  fontSize: 13.5,
                  fontWeight: 700,
                  mt: 0.375,
                  fontFamily: "ui-monospace, Menlo, monospace",
                  color: check.passed ? "#a6f0c4" : "#ff8d8d"
                }}
              >
                {check.observed}
              </Typography>
            </Box>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

// ── Outcome banner ────────────────────────────────────────────────

function OutcomeBanner({ incident }: { incident: Incident }) {
  if (incident.state === "RESOLVED" || incident.state === "CLOSED") {
    return (
      <Box
        sx={{
          mt: 2,
          display: "flex",
          alignItems: "center",
          gap: 1.25,
          px: 1.875,
          py: 1.375,
          borderRadius: "11px",
          border: "1px solid rgba(114,227,163,.35)",
          bgcolor: "rgba(114,227,163,.05)",
          color: "#a6f0c4",
          fontSize: 13.5,
          fontWeight: 600
        }}
      >
        <CheckCircleRounded sx={{ fontSize: 16, flexShrink: 0 }} />
        Action completed — verification passed. Incident resolved.
      </Box>
    );
  }
  if (incident.state === "ROLLED_BACK" || incident.state === "ESCALATED") {
    return (
      <Alert
        severity="warning"
        variant="outlined"
        sx={{ mt: 2, py: 0.625, fontSize: 13.5, fontWeight: 600 }}
      >
        Verification failed — action auto-reverted to the snapshot, then escalated.
      </Alert>
    );
  }
  return null;
}

// ── Main component ────────────────────────────────────────────────

export function IncidentDetail(props: {
  incident: Incident | null;
  records: AuditRecord[];
  health: Health;
  busy: boolean;
  onAction: (action: "plan" | "approve" | "deny" | "fail") => void;
}) {
  const [tab, setTab] = useState(0);

  if (!props.incident) {
    return (
      <Paper sx={{ ...surface, minHeight: 540 }}>
        <Stack
          alignItems="center"
          justifyContent="center"
          sx={{ minHeight: 540, px: 4, textAlign: "center" }}
        >
          <Avatar
            sx={{
              width: 58,
              height: 58,
              bgcolor: "rgba(114, 227, 163, .08)",
              color: "primary.main",
              mb: 2
            }}
          >
            <FactCheckOutlined />
          </Avatar>
          <Typography variant="h2">Ready for a safe decision</Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ maxWidth: 390, mt: 1, lineHeight: 1.65 }}
          >
            Select an incident to inspect its evidence, proposed action, blast radius, and audit
            timeline.
          </Typography>
        </Stack>
      </Paper>
    );
  }

  const incident = props.incident;
  const records = props.records;

  // Derive lifecycle steps
  const steps = buildSteps(incident.state, records);

  // Derive snapshot data from audit records
  const snapshotRecord = records.find((r) => r.eventType === "snapshot");
  const snapshotData: SnapshotData | null = snapshotRecord
    ? (() => {
        const p = snapshotRecord.payload as { id?: string; capturedAt?: string } | null;
        return p?.id ? { id: p.id, capturedAt: p.capturedAt ?? snapshotRecord.ts } : null;
      })()
    : null;

  // Derive verification data from audit records
  const verificationRecord = records.find((r) => r.eventType === "verification");
  const verificationData = verificationRecord
    ? (() => {
        const p = verificationRecord.payload as {
          ok?: boolean;
          checks?: VerificationCheck[];
        } | null;
        return { ok: p?.ok ?? false, checks: p?.checks ?? [] };
      })()
    : null;

  // Rollback target from aws_action payload
  const awsActionRecord = records.find((r) => r.eventType === "aws_action");
  const rollbackTo = awsActionRecord
    ? ((awsActionRecord.payload as { taskDefinition?: string } | null)?.taskDefinition ?? null)
    : null;

  const isReverted = ["ROLLING_BACK", "ROLLED_BACK", "ESCALATED"].includes(incident.state);
  const hasSnapshot = snapshotData !== null;

  const tabLabels = [
    `Verification (${verificationData?.checks.length ?? 0})`,
    `Audit (${records.length})`,
    `Evidence (${incident.evidence.length})`
  ];

  return (
    <Paper sx={{ ...surface, minHeight: 540, p: { xs: 2, md: "26px" } }}>
      {/* Header */}
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={2}>
        <Box>
          <Stack direction="row" alignItems="center" spacing={1.25} sx={{ mb: 1.25 }}>
            <Chip
              size="small"
              label={incident.environment}
              variant="outlined"
              sx={{
                height: 24,
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: ".02em",
                textTransform: "capitalize",
                borderColor: "rgba(212,230,220,.16)",
                color: "#cdd9d2"
              }}
            />
            <Typography sx={{ fontSize: 12, color: "#9aafa5" }}>
              {fmt(incident.source)}
            </Typography>
          </Stack>
          <Typography sx={{ fontSize: 22, fontWeight: 680, letterSpacing: "-0.02em" }}>
            {fmt(incident.type)}
          </Typography>
          <Typography
            sx={{
              fontSize: 13,
              color: "#9aafa5",
              mt: 0.875,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
            }}
          >
            {incident.service} · opened{" "}
            {new Date(incident.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit"
            })}
          </Typography>
        </Box>
        <Box sx={{ minWidth: 150 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="baseline">
            <Typography sx={{ fontSize: 12, color: "#9aafa5" }}>Confidence</Typography>
            <Typography sx={{ fontSize: 13, color: "#a6f0c4", fontWeight: 700 }}>
              {Math.round(incident.confidence * 100)}%
            </Typography>
          </Stack>
          <LinearProgress
            variant="determinate"
            value={incident.confidence * 100}
            sx={{
              mt: 1,
              height: 5,
              borderRadius: 999,
              bgcolor: "rgba(255,255,255,.06)",
              "& .MuiLinearProgress-bar": { bgcolor: "primary.main" }
            }}
          />
        </Box>
      </Stack>

      {/* Lifecycle stepper */}
      <LifecycleStepper steps={steps} />

      {/* Deploy correlation banner */}
      {incident.deployCorrelation && (
        <Box
          sx={{
            mt: 3.25,
            display: "flex",
            alignItems: "center",
            gap: 1.75,
            flexWrap: "wrap",
            px: 2,
            py: 1.625,
            borderRadius: "11px",
            bgcolor: "rgba(142,183,255,.05)",
            border: "1px solid rgba(142,183,255,.16)"
          }}
        >
          <Typography
            sx={{
              fontSize: 10,
              letterSpacing: ".1em",
              fontWeight: 700,
              color: "#9abaff"
            }}
          >
            DEPLOY CORRELATION
          </Typography>
          <Typography sx={{ fontSize: 12.5, color: "#cdd9d2" }}>
            Triggered by{" "}
            <Typography
              component="span"
              sx={{ fontFamily: "ui-monospace, Menlo, monospace", color: "#f4f7f5", fontSize: "inherit" }}
            >
              {incident.deployCorrelation.deployId}
            </Typography>{" "}
            at{" "}
            {new Date(incident.deployCorrelation.deployedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit"
            })}
          </Typography>
          {rollbackTo && (
            <Stack
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{
                ml: "auto",
                fontSize: 12.5,
                fontFamily: "ui-monospace, Menlo, monospace",
                color: "#9aafa5"
              }}
            >
              <Typography
                sx={{
                  fontFamily: "inherit",
                  fontSize: "inherit",
                  textDecoration: "line-through",
                  opacity: 0.7
                }}
              >
                {incident.deployCorrelation.artifactRef}
              </Typography>
              <Typography sx={{ fontFamily: "inherit", fontSize: "inherit", color: "primary.main" }}>
                →
              </Typography>
              <Typography sx={{ fontFamily: "inherit", fontSize: "inherit", color: "#a6f0c4" }}>
                {rollbackTo}
              </Typography>
            </Stack>
          )}
        </Box>
      )}

      {/* Outcome banner */}
      <OutcomeBanner incident={incident} />

      {/* Policy decision + snapshot */}
      <Box
        sx={{
          mt: 2,
          display: "grid",
          gridTemplateColumns: hasSnapshot ? { xs: "1fr", md: "1.55fr 1fr" } : "1fr",
          gap: 1.75
        }}
      >
        <ActionPanel
          incident={incident}
          health={props.health}
          busy={props.busy}
          onAction={props.onAction}
        />
        {hasSnapshot && (
          <SnapshotCard data={snapshotData!} isReverted={isReverted} />
        )}
      </Box>

      {/* Tabs */}
      <Box sx={{ mt: 3.25 }}>
        <Tabs
          value={tab}
          onChange={(_e, v: number) => setTab(v)}
          sx={{
            mb: 2.25,
            borderBottom: "1px solid rgba(212,230,220,.09)",
            minHeight: 40,
            "& .MuiTab-root": {
              minHeight: 40,
              py: 1.1,
              px: 1.75,
              fontSize: 12.5,
              fontWeight: 650,
              color: "#dfe7e2",
              textTransform: "none",
              letterSpacing: 0
            },
            "& .MuiTabs-indicator": { bgcolor: "primary.main", height: 2 }
          }}
        >
          {tabLabels.map((l) => (
            <Tab key={l} label={l} />
          ))}
        </Tabs>

        {/* Verification */}
        <Collapse in={tab === 0} unmountOnExit>
          <VerificationPanel
            checks={verificationData?.checks ?? []}
            ok={verificationData?.ok ?? false}
          />
        </Collapse>

        {/* Audit trail */}
        <Collapse in={tab === 1} unmountOnExit>
          <AuditTimeline records={records} />
        </Collapse>

        {/* Evidence */}
        <Collapse in={tab === 2} unmountOnExit>
          {incident.evidence.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: "center" }}>
              No evidence items recorded.
            </Typography>
          ) : (
            <Stack spacing={1.375}>
              {incident.evidence.map((item) => (
                <EvidenceCard key={`${item.ref}-${item.observedAt}`} evidence={item} />
              ))}
            </Stack>
          )}
        </Collapse>
      </Box>
    </Paper>
  );
}
