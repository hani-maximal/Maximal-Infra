import { useMemo, useState } from "react";
import {
  Avatar,
  Box,
  Chip,
  Divider,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Typography
} from "@mui/material";
import {
  CheckCircleRounded,
  DescriptionOutlined,
  SearchRounded,
  ShieldOutlined
} from "@mui/icons-material";
import type { Contract } from "../types.js";
import { formatLabel as label } from "../utils.js";

const surface = {
  border: "1px solid",
  borderColor: "divider",
  bgcolor: "rgba(17, 22, 20, 0.82)",
  backdropFilter: "blur(18px)"
};

export function ContractsView({ contracts }: { contracts: Contract[] }) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return contracts;
    return contracts.filter(
      (c) =>
        c.incident_type.toLowerCase().includes(q) ||
        c.approval.mode.toLowerCase().includes(q) ||
        c.allowed_actions.some((a) => a.toLowerCase().includes(q))
    );
  }, [contracts, search]);

  return (
    <Box>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        gap={2}
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography
            variant="overline"
            color="primary.main"
            sx={{ letterSpacing: ".15em", fontSize: 10 }}
          >
            Policy library
          </Typography>
          <Typography variant="h1">Remediation contracts</Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            Pre-approved boundaries for every diagnosis and action.
          </Typography>
        </Box>
        <Chip
          icon={<CheckCircleRounded />}
          color="success"
          variant="outlined"
          label={`${contracts.length} validated at boot`}
        />
      </Stack>

      {contracts.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <TextField
            size="small"
            placeholder="Search by type, action, or approval mode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            fullWidth
            inputProps={{ "aria-label": "Search contracts" }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded sx={{ fontSize: 16, color: "text.secondary" }} />
                </InputAdornment>
              )
            }}
            sx={{ maxWidth: 420, "& .MuiOutlinedInput-root": { fontSize: 13 } }}
          />
        </Box>
      )}

      {contracts.length === 0 ? (
        <Stack
          alignItems="center"
          justifyContent="center"
          sx={{ minHeight: 300, textAlign: "center" }}
        >
          <Avatar
            sx={{
              width: 52,
              height: 52,
              bgcolor: "rgba(114, 227, 163, .08)",
              color: "primary.main",
              mb: 2
            }}
          >
            <ShieldOutlined />
          </Avatar>
          <Typography variant="h3">No contracts loaded</Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ maxWidth: 320, mt: 1, lineHeight: 1.65 }}
          >
            Check that <code>CONTRACTS_DIR</code> points to the correct directory and restart the
            server.
          </Typography>
        </Stack>
      ) : filtered.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
          No contracts match "{search}"
        </Typography>
      ) : (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              md: "repeat(2, 1fr)",
              xl: "repeat(3, 1fr)"
            },
            gap: 1.5
          }}
        >
          {filtered.map((contract) => (
            <Paper key={contract.incident_type} sx={{ ...surface, p: 2.25 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
                <Avatar
                  sx={{ width: 36, height: 36, bgcolor: "rgba(114, 227, 163, .08)", color: "primary.main" }}
                >
                  <DescriptionOutlined sx={{ fontSize: 19 }} />
                </Avatar>
                <Chip
                  size="small"
                  label={contract.approval.mode === "always_human" ? "Human approval" : "Bounded auto"}
                  color={contract.approval.mode === "always_human" ? "warning" : "success"}
                  variant="outlined"
                  sx={{ fontSize: 10 }}
                />
              </Stack>
              <Typography variant="h3" sx={{ mt: 2 }}>
                {label(contract.incident_type)}
              </Typography>
              <Stack direction="row" spacing={2.5} sx={{ mt: 1.5 }}>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Confidence
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 0.3 }}>
                    {Math.round(contract.min_confidence * 100)}% min
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Verify
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 0.3 }}>
                    {contract.verify.window}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Scope
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 0.3 }}>
                    {contract.approval.blast_radius.max_affected_services} service
                  </Typography>
                </Box>
              </Stack>
              <Divider sx={{ my: 1.75 }} />
              <Stack direction="row" gap={0.6} flexWrap="wrap">
                {contract.allowed_actions.slice(0, 3).map((action) => (
                  <Chip
                    key={action}
                    size="small"
                    label={label(action)}
                    sx={{ height: 23, fontSize: 9.5, bgcolor: "rgba(255,255,255,.035)" }}
                  />
                ))}
                {contract.allowed_actions.length > 3 && (
                  <Chip
                    size="small"
                    label={`+${contract.allowed_actions.length - 3}`}
                    sx={{ height: 23 }}
                  />
                )}
              </Stack>
            </Paper>
          ))}
        </Box>
      )}
    </Box>
  );
}
