import { useMemo, useState } from "react";
import {
  Avatar,
  Box,
  Button,
  Chip,
  Divider,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography
} from "@mui/material";
import {
  AddRounded,
  AutoAwesomeRounded,
  CloudQueueRounded,
  SearchRounded,
  ShieldOutlined
} from "@mui/icons-material";
import type { Incident } from "../types.js";
import { formatLabel } from "../utils.js";

function label(value: string): string {
  return formatLabel(value);
}

function stateTone(state: string): "success" | "warning" | "error" | "default" {
  if (["CLOSED", "RESOLVED"].includes(state)) return "success";
  if (state === "AWAITING_APPROVAL") return "warning";
  if (state === "ESCALATED") return "error";
  return "default";
}

function EmptyState({ onSimulate }: { onSimulate: () => void }) {
  return (
    <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 430, px: 4, textAlign: "center" }}>
      <Avatar
        sx={{ width: 52, height: 52, bgcolor: "rgba(114, 227, 163, .08)", color: "primary.main", mb: 2 }}
      >
        <ShieldOutlined />
      </Avatar>
      <Typography variant="h3">No incidents in the queue</Typography>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ maxWidth: 320, mt: 1, lineHeight: 1.65 }}
      >
        Simulate a known failure pattern to walk through classification, policy, approval, and
        verification.
      </Typography>
      <Button startIcon={<AddRounded />} variant="outlined" onClick={onSimulate} sx={{ mt: 2.5 }}>
        Simulate incident
      </Button>
    </Stack>
  );
}

export function IncidentQueue(props: {
  incidents: Incident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSimulate: () => void;
}) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return props.incidents;
    return props.incidents.filter(
      (inc) =>
        inc.service.toLowerCase().includes(q) ||
        inc.type.toLowerCase().includes(q) ||
        inc.environment.toLowerCase().includes(q) ||
        inc.state.toLowerCase().includes(q)
    );
  }, [props.incidents, search]);

  const surface = {
    border: "1px solid",
    borderColor: "divider",
    bgcolor: "rgba(17, 22, 20, 0.82)",
    backdropFilter: "blur(18px)"
  };

  return (
    <Paper sx={{ ...surface, overflow: "hidden", minHeight: 540 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ px: 2.25, py: 2 }}
      >
        <Box>
          <Typography
            variant="overline"
            color="primary.main"
            sx={{ letterSpacing: ".14em", fontSize: 10 }}
          >
            Live queue
          </Typography>
          <Typography variant="h2">Incidents</Typography>
        </Box>
        <Chip
          size="small"
          label={`${props.incidents.length} total`}
          variant="outlined"
        />
      </Stack>

      {props.incidents.length > 0 && (
        <Box sx={{ px: 2.25, pb: 1.5 }}>
          <TextField
            size="small"
            placeholder="Search by service, type, state…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            fullWidth
            inputProps={{ "aria-label": "Search incidents" }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded sx={{ fontSize: 16, color: "text.secondary" }} />
                </InputAdornment>
              )
            }}
            sx={{ "& .MuiOutlinedInput-root": { fontSize: 13 } }}
          />
        </Box>
      )}

      <Divider />

      {props.incidents.length === 0 ? (
        <EmptyState onSimulate={props.onSimulate} />
      ) : filtered.length === 0 ? (
        <Stack alignItems="center" sx={{ py: 6, px: 3, textAlign: "center" }}>
          <Typography variant="body2" color="text.secondary">
            No incidents match "{search}"
          </Typography>
        </Stack>
      ) : (
        <List disablePadding>
          {filtered.map((incident) => (
            <ListItemButton
              key={incident.id}
              selected={incident.id === props.selectedId}
              onClick={() => props.onSelect(incident.id)}
              sx={{
                px: 2.25,
                py: 1.75,
                gap: 1,
                borderBottom: "1px solid",
                borderColor: "divider",
                "&.Mui-selected": {
                  bgcolor: "rgba(114, 227, 163, .065)",
                  boxShadow: "inset 2px 0 #72e3a3"
                },
                "&.Mui-selected:hover": { bgcolor: "rgba(114, 227, 163, .09)" }
              }}
            >
              <ListItemIcon sx={{ minWidth: 36 }}>
                <Avatar
                  sx={{
                    width: 30,
                    height: 30,
                    bgcolor: "rgba(255,255,255,.045)",
                    color: "text.secondary"
                  }}
                >
                  {incident.type.startsWith("lambda") ? (
                    <AutoAwesomeRounded sx={{ fontSize: 16 }} />
                  ) : (
                    <CloudQueueRounded sx={{ fontSize: 16 }} />
                  )}
                </Avatar>
              </ListItemIcon>
              <ListItemText
                primary={incident.service}
                secondary={`${label(incident.type)} · ${incident.environment}`}
                primaryTypographyProps={{ fontSize: 13.5, fontWeight: 650 }}
                secondaryTypographyProps={{ fontSize: 11.5, mt: 0.4, noWrap: true }}
              />
              <Stack alignItems="flex-end" spacing={0.7}>
                <Chip
                  size="small"
                  color={stateTone(incident.state)}
                  label={label(incident.state)}
                  variant="outlined"
                  sx={{ height: 23, fontSize: 9.5 }}
                />
                <Typography variant="caption" color="text.secondary">
                  {Math.round(incident.confidence * 100)}%
                </Typography>
              </Stack>
            </ListItemButton>
          ))}
        </List>
      )}
    </Paper>
  );
}
