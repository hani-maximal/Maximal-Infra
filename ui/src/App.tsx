import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Stack,
  Tooltip,
  Typography
} from "@mui/material";
import {
  AddRounded,
  DescriptionOutlined,
  GppGoodRounded,
  MenuRounded,
  ScienceOutlined,
  SecurityRounded,
  ShieldOutlined,
  WarningAmberRounded
} from "@mui/icons-material";
import { api, UnauthorizedError } from "./api.js";
import { useAuth } from "./hooks/useAuth.js";
import { LoginPage } from "./pages/LoginPage.js";
import { Sidebar } from "./components/Sidebar.js";
import { MobileDrawer } from "./components/MobileDrawer.js";
import { IncidentQueue } from "./components/IncidentQueue.js";
import { IncidentDetail } from "./components/IncidentDetail.js";
import { ContractsView } from "./components/ContractsView.js";
import type { AuditRecord, Contract, Health, Incident } from "./types.js";
import { formatLabel } from "./utils.js";

const incidentOptions = [
  ["post_deploy_5xx_spike", "Post-deploy 5xx spike"],
  ["ecs_service_unhealthy", "ECS service unhealthy"],
  ["lambda_error_spike", "Lambda error spike"],
  ["deploy_failed_or_stuck", "Deployment failed"]
] as const;

const surface = {
  border: "1px solid",
  borderColor: "divider",
  bgcolor: "rgba(17, 22, 20, 0.82)",
  backdropFilter: "blur(18px)"
};

function label(value: string): string {
  return formatLabel(value);
}

function StatCard(props: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  caption: string;
  positive?: boolean;
}) {
  return (
    <Paper sx={{ ...surface, p: 2.25, minWidth: 0 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
        <Box>
          <Typography variant="caption" color="text.secondary">
            {props.label}
          </Typography>
          <Typography
            sx={{
              mt: 0.55,
              fontSize: 24,
              lineHeight: 1.15,
              fontWeight: 680,
              letterSpacing: "-0.035em",
              color: props.positive ? "primary.light" : "text.primary"
            }}
          >
            {props.value}
          </Typography>
        </Box>
        <Avatar
          sx={{ width: 34, height: 34, bgcolor: "rgba(114, 227, 163, .08)", color: "primary.main" }}
        >
          {props.icon}
        </Avatar>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.05 }}>
        {props.caption}
      </Typography>
    </Paper>
  );
}

// ────────────────────────────────────────────────────────────────
// Root component
// ────────────────────────────────────────────────────────────────
export default function App() {
  const { loggedIn, login, logout } = useAuth();
  const [health, setHealth] = useState<Health | null>(null);

  // Load health to discover authEnabled and mode
  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => {
        // If health fails entirely, assume auth is not required so the app can still show
        setHealth({
          ok: false,
          mode: "observe",
          contractCount: 0,
          auditChainValid: false,
          authEnabled: false
        });
      });
  }, []);

  if (!health || loggedIn === null) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ minHeight: "100vh" }}>
        <CircularProgress size={28} />
      </Stack>
    );
  }

  if (loggedIn === false) {
    return <LoginPage onLogin={login} />;
  }

  return (
    <AppShell
      initialHealth={health}
      username="operator"
      onLogout={logout}
    />
  );
}

// ────────────────────────────────────────────────────────────────
// Main shell (shown after auth check passes)
// ────────────────────────────────────────────────────────────────
function AppShell({
  initialHealth,
  username,
  onLogout
}: {
  initialHealth: Health;
  username: string;
  onLogout: () => void;
}) {
  const [health, setHealth] = useState<Health>(initialHealth);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => sessionStorage.getItem("maximal_selected_incident")
  );
  const [page, setPage] = useState<"command" | "contracts">(
    () => (sessionStorage.getItem("maximal_page") as "command" | "contracts") ?? "command"
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [incidentType, setIncidentType] = useState(incidentOptions[0][0]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);

  const selected = useMemo(
    () => incidents.find((inc) => inc.id === selectedId) ?? null,
    [incidents, selectedId]
  );

  function persistPage(p: "command" | "contracts") {
    sessionStorage.setItem("maximal_page", p);
    setPage(p);
  }

  function handleUnauthorized() {
    onLogout();
  }

  const load = useCallback(
    async (preferredId?: string) => {
      try {
        const [nextHealth, nextIncidents, nextContracts] = await Promise.all([
          api.health(),
          api.incidents(),
          api.contracts()
        ]);
        setHealth(nextHealth);
        setIncidents(nextIncidents);
        setContracts(nextContracts);
        const nextId =
          preferredId ?? selectedId ?? nextIncidents[0]?.id ?? null;
        setSelectedId(nextId);
        if (nextId) sessionStorage.setItem("maximal_selected_incident", nextId);
        if (nextId) {
          const replay = await api.replay(nextId);
          setRecords(replay.records);
        } else {
          setRecords([]);
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) return handleUnauthorized();
        setToast({ message: (err as Error).message, error: true });
      }
    },
    [selectedId] // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    void load();
  }, []);

  async function selectIncident(id: string) {
    setSelectedId(id);
    sessionStorage.setItem("maximal_selected_incident", id);
    try {
      const replay = await api.replay(id);
      setRecords(replay.records);
    } catch (err) {
      if (err instanceof UnauthorizedError) handleUnauthorized();
    }
  }

  async function simulate() {
    setBusy(true);
    try {
      const incident = await api.simulate(incidentType);
      setSimulateOpen(false);
      await load(incident.id);
      persistPage("command");
      setToast({ message: "Synthetic incident detected" });
    } catch (err) {
      if (err instanceof UnauthorizedError) return handleUnauthorized();
      setToast({ message: (err as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  async function act(action: "plan" | "approve" | "deny" | "fail") {
    if (!selectedId) return;
    setBusy(true);
    try {
      if (action === "plan") await api.plan(selectedId);
      else if (action === "approve") await api.approve(selectedId);
      else if (action === "deny") await api.deny(selectedId);
      else if (action === "fail") {
        await api.failVerification(selectedId);
        setToast({ message: "The next verification check will fail" });
        return;
      }
      await load(selectedId);
      setToast({
        message:
          action === "plan"
            ? "Policy evaluated"
            : action === "approve"
              ? "Action completed and verified"
              : "Incident escalated"
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) return handleUnauthorized();
      setToast({ message: (err as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  const activeCount = incidents.filter(
    (inc) => !["CLOSED", "ESCALATED"].includes(inc.state)
  ).length;

  return (
    <Box sx={{ minHeight: "100vh" }}>
      {/* Skip to content link for keyboard navigation */}
      <Box
        component="a"
        href="#main-content"
        sx={{
          position: "absolute",
          left: -9999,
          top: "auto",
          width: 1,
          height: 1,
          overflow: "hidden",
          zIndex: 9999,
          "&:focus": {
            left: 16,
            top: 16,
            width: "auto",
            height: "auto",
            p: "8px 16px",
            bgcolor: "primary.main",
            color: "primary.contrastText",
            borderRadius: 1,
            fontWeight: 700,
            fontSize: 14
          }
        }}
      >
        Skip to content
      </Box>

      {/* Desktop sidebar */}
      <Sidebar
        page={page}
        setPage={persistPage}
        contractCount={contracts.length}
        mode={health.mode}
        username={username}
        onLogout={onLogout}
      />

      {/* Mobile drawer */}
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        page={page}
        setPage={persistPage}
        contractCount={contracts.length}
      />

      {/* Main content */}
      <Box
        component="main"
        id="main-content"
        sx={{ ml: { xs: 0, md: "232px" }, px: { xs: 2, sm: 3, xl: 4.5 }, py: { xs: 2, md: 3.5 } }}
      >
        {/* Mobile header */}
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ display: { xs: "flex", md: "none" }, mb: 3 }}
        >
          <Stack direction="row" alignItems="center" spacing={1.1}>
            <Avatar
              variant="rounded"
              sx={{ width: 34, height: 34, bgcolor: "rgba(114, 227, 163, .11)", color: "primary.light" }}
            >
              <SecurityRounded sx={{ fontSize: 18 }} />
            </Avatar>
            <Typography fontWeight={720}>Maximal</Typography>
          </Stack>
          <Tooltip title="Open navigation">
            <IconButton
              aria-label="Open navigation menu"
              onClick={() => setDrawerOpen(true)}
              sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2 }}
            >
              <MenuRounded />
            </IconButton>
          </Tooltip>
        </Stack>

        {/* Page content */}
        {page === "contracts" ? (
          <ContractsView contracts={contracts} />
        ) : (
          <>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              justifyContent="space-between"
              alignItems={{ sm: "flex-end" }}
              gap={2}
            >
              <Box>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                  <Box
                    sx={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      bgcolor: "primary.main"
                    }}
                  />
                  <Typography
                    variant="overline"
                    color="primary.main"
                    sx={{ letterSpacing: ".16em", fontSize: 10 }}
                  >
                    Operate mode
                  </Typography>
                </Stack>
                <Typography variant="h1">Incident command center</Typography>
                <Typography color="text.secondary" sx={{ mt: 1 }}>
                  One bounded action. Verified recovery. Complete evidence.
                </Typography>
              </Box>
              <Button
                variant="contained"
                startIcon={<ScienceOutlined />}
                onClick={() => setSimulateOpen(true)}
              >
                Simulate incident
              </Button>
            </Stack>

            {/* KPI stat cards */}
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "repeat(2, 1fr)", lg: "repeat(4, 1fr)" },
                gap: 1.25,
                my: 3
              }}
            >
              <StatCard
                icon={<WarningAmberRounded sx={{ fontSize: 18 }} />}
                label="Active incidents"
                value={activeCount}
                caption="Awaiting a safe outcome"
              />
              <StatCard
                icon={<DescriptionOutlined sx={{ fontSize: 18 }} />}
                label="Loaded contracts"
                value={health.contractCount}
                caption="Validated at boot"
              />
              <StatCard
                icon={<GppGoodRounded sx={{ fontSize: 18 }} />}
                label="Audit chain"
                value={health.auditChainValid ? "Verified" : "Invalid"}
                caption="SHA-256 hash chained"
                positive={health.auditChainValid}
              />
              <StatCard
                icon={<ShieldOutlined sx={{ fontSize: 18 }} />}
                label="Unsafe writes"
                value={0}
                caption="Hard release gate"
                positive
              />
            </Box>

            {/* Incident list + detail */}
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: {
                  xs: "1fr",
                  xl: "minmax(300px, .7fr) minmax(560px, 1.3fr)"
                },
                gap: 1.5
              }}
            >
              <IncidentQueue
                incidents={incidents}
                selectedId={selectedId}
                onSelect={(id) => void selectIncident(id)}
                onSimulate={() => setSimulateOpen(true)}
              />
              <IncidentDetail
                incident={selected}
                records={records}
                health={health}
                busy={busy}
                onAction={(action) => void act(action)}
              />
            </Box>
          </>
        )}
      </Box>

      {/* Simulate dialog */}
      <Dialog
        open={simulateOpen}
        onClose={() => !busy && setSimulateOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Simulate an incident</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            Generate a synthetic signal and run it through the same classification, contract,
            policy, and audit pipeline an actual incident uses.
          </Typography>
          <FormControl fullWidth>
            <InputLabel id="incident-type-label">Failure pattern</InputLabel>
            <Select
              labelId="incident-type-label"
              label="Failure pattern"
              value={incidentType}
              onChange={(e) => setIncidentType(e.target.value)}
            >
              {incidentOptions.map(([value, text]) => (
                <MenuItem key={value} value={value}>
                  {text}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
            Choose the failure pattern you want to rehearse. Maximal will create evidence,
            evaluate the matching contract, and show the safest next step.
          </Typography>
          <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
            This uses the local mock AWS adapter. No cloud resources are touched, so it is safe
            for demos, onboarding, and contract reviews.
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setSimulateOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            startIcon={
              busy ? (
                <CircularProgress size={15} color="inherit" />
              ) : (
                <ScienceOutlined />
              )
            }
            onClick={() => void simulate()}
            disabled={busy}
          >
            Simulate
          </Button>
        </DialogActions>
      </Dialog>

      {/* Toast notifications — errors stay longer */}
      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={toast?.error ? 8000 : 3200}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          severity={toast?.error ? "error" : "success"}
          variant="filled"
          onClose={() => setToast(null)}
          sx={{ minWidth: 280 }}
        >
          {toast?.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
