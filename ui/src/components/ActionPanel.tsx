import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Typography
} from "@mui/material";
import {
  CheckCircleRounded,
  GppGoodRounded,
  PlayArrowRounded,
  WarningAmberRounded
} from "@mui/icons-material";
import type { Health, Incident } from "../types.js";
import { formatLabel } from "../utils.js";

function label(value: string): string {
  return formatLabel(value);
}

export function ActionPanel(props: {
  incident: Incident;
  health: Health;
  busy: boolean;
  onAction: (action: "plan" | "approve" | "deny" | "fail") => void;
}) {
  const { incident, health } = props;
  const plan = incident.plan;
  const canPlan = incident.state === "DETECTED";
  const canApprove = incident.state === "AWAITING_APPROVAL" && health.mode !== "observe";
  const canDeny = incident.state === "AWAITING_APPROVAL";
  const decisionColor =
    plan?.policy.decision === "ESCALATE"
      ? "error.main"
      : plan?.policy.decision === "APPROVE"
        ? "warning.main"
        : "primary.main";

  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleApproveClick() {
    setConfirmOpen(true);
  }

  function handleConfirm() {
    setConfirmOpen(false);
    props.onAction("approve");
  }

  return (
    <>
      <Box
        sx={{
          p: 2,
          mt: 2.5,
          bgcolor: "rgba(114, 227, 163, .035)",
          border: "1px solid rgba(114, 227, 163, .2)",
          borderRadius: 2
        }}
      >
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={2}>
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <GppGoodRounded sx={{ fontSize: 18, color: decisionColor }} />
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ letterSpacing: ".1em", fontWeight: 700 }}
              >
                {plan ? "POLICY DECISION" : "NEXT SAFE STEP"}
              </Typography>
            </Stack>
            <Typography
              sx={{
                mt: 1,
                fontSize: 14.5,
                fontWeight: 680,
                fontFamily: "ui-monospace, monospace"
              }}
            >
              {plan
                ? `${plan.policy.decision} · ${plan.actionType}`
                : "Classify and evaluate contract"}
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 0.7, maxWidth: 660, lineHeight: 1.6 }}
            >
              {plan
                ? plan.policy.reasons.map(label).join(" · ")
                : "No action is selected until confidence, allowlists, blast radius, and reversibility have passed."}
            </Typography>
          </Box>
          {plan && (
            <Stack direction="row" spacing={2.5} sx={{ flexShrink: 0 }}>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Scope
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.4 }}>
                  {plan.policy.blastRadius.affectedServices.length} service
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Environment
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.4 }}>
                  {plan.policy.blastRadius.environment}
                </Typography>
              </Box>
            </Stack>
          )}
        </Stack>

        {(canPlan || canApprove || canDeny) && (
          <>
            <Divider sx={{ my: 2 }} />
            <Stack direction="row" gap={1} flexWrap="wrap">
              {canPlan && (
                <Button
                  variant="contained"
                  startIcon={
                    props.busy ? (
                      <CircularProgress size={15} color="inherit" />
                    ) : (
                      <PlayArrowRounded />
                    )
                  }
                  disabled={props.busy}
                  onClick={() => props.onAction("plan")}
                >
                  Evaluate plan
                </Button>
              )}
              {canApprove && (
                <Button
                  variant="contained"
                  startIcon={
                    props.busy ? (
                      <CircularProgress size={15} color="inherit" />
                    ) : (
                      <CheckCircleRounded />
                    )
                  }
                  disabled={props.busy}
                  onClick={handleApproveClick}
                >
                  Approve action
                </Button>
              )}
              {canDeny && (
                <Button
                  color="error"
                  variant="outlined"
                  disabled={props.busy}
                  onClick={() => props.onAction("deny")}
                >
                  Deny &amp; escalate
                </Button>
              )}
              {canApprove && (
                <Button
                  color="inherit"
                  variant="text"
                  disabled={props.busy}
                  onClick={() => props.onAction("fail")}
                >
                  Induce verification failure
                </Button>
              )}
            </Stack>
          </>
        )}
      </Box>

      {/* Confirmation dialog for Approve */}
      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <WarningAmberRounded sx={{ color: "warning.main", fontSize: 22 }} />
          Confirm live AWS action
        </DialogTitle>
        <DialogContent>
          <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>
            We ask for confirmation because this step can change AWS state. The action has already
            passed contract policy; approval is the final human checkpoint.
          </Alert>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This will execute a real AWS action against the following target:
          </Typography>
          <Box
            sx={{
              p: 1.75,
              borderRadius: 2,
              border: "1px solid",
              borderColor: "divider",
              bgcolor: "rgba(245, 199, 109, .04)"
            }}
          >
            <Stack spacing={1}>
              <Row label="Action" value={plan?.actionType ?? "—"} mono />
              <Row label="Service" value={incident.service} />
              <Row label="Environment" value={incident.environment} />
              {plan && (
                <Row
                  label="Scope"
                  value={`${plan.policy.blastRadius.affectedServices.length} service(s)`}
                />
              )}
            </Stack>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
            Maximal captures a pre-action snapshot, records the decision in the audit chain, and
            runs verification after execution. If verification fails, the action will be
            automatically reverted when rollback is enabled.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleConfirm}>
            Execute action
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function Row({
  label: lbl,
  value,
  mono
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={1}>
      <Typography variant="caption" color="text.secondary">
        {lbl}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          fontWeight: 650,
          fontFamily: mono ? "ui-monospace, monospace" : undefined,
          textAlign: "right"
        }}
      >
        {value}
      </Typography>
    </Stack>
  );
}
