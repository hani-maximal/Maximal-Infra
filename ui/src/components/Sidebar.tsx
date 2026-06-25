import {
  Avatar,
  Box,
  Chip,
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  Tooltip,
  Typography
} from "@mui/material";
import {
  DashboardRounded,
  LogoutRounded,
  MenuBookRounded,
  PersonRounded,
  SecurityRounded
} from "@mui/icons-material";

export function Sidebar(props: {
  page: "command" | "contracts";
  setPage: (p: "command" | "contracts") => void;
  contractCount: number;
  mode: string;
  username: string;
  onLogout: () => void;
}) {
  const modeLabel =
    props.mode === "bounded_auto"
      ? "Bounded auto"
      : props.mode.charAt(0).toUpperCase() + props.mode.slice(1);

  return (
    <Box
      component="aside"
      aria-label="Main navigation"
      sx={{
        position: "fixed",
        inset: "0 auto 0 0",
        width: 232,
        p: 2,
        borderRight: "1px solid",
        borderColor: "divider",
        bgcolor: "rgba(8, 12, 11, .91)",
        backdropFilter: "blur(20px)",
        display: { xs: "none", md: "flex" },
        flexDirection: "column",
        zIndex: 10
      }}
    >
      {/* Brand */}
      <Stack direction="row" alignItems="center" spacing={1.3} sx={{ px: 1, py: 1 }}>
        <Avatar
          variant="rounded"
          sx={{
            width: 36,
            height: 36,
            bgcolor: "rgba(114, 227, 163, .11)",
            color: "primary.light",
            border: "1px solid rgba(114, 227, 163, .25)"
          }}
        >
          <SecurityRounded sx={{ fontSize: 19 }} />
        </Avatar>
        <Box>
          <Typography fontWeight={720} letterSpacing="-.02em">
            Maximal
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Safe execution
          </Typography>
        </Box>
      </Stack>

      {/* Nav */}
      <List sx={{ mt: 4 }}>
        <ListItemButton
          selected={props.page === "command"}
          onClick={() => props.setPage("command")}
          sx={{ borderRadius: 2, mb: 0.7 }}
          aria-current={props.page === "command" ? "page" : undefined}
        >
          <ListItemIcon sx={{ minWidth: 36 }}>
            <DashboardRounded fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Command center"
            primaryTypographyProps={{ fontSize: 13, fontWeight: 600 }}
          />
        </ListItemButton>
        <ListItemButton
          selected={props.page === "contracts"}
          onClick={() => props.setPage("contracts")}
          sx={{ borderRadius: 2 }}
          aria-current={props.page === "contracts" ? "page" : undefined}
        >
          <ListItemIcon sx={{ minWidth: 36 }}>
            <MenuBookRounded fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Contracts"
            primaryTypographyProps={{ fontSize: 13, fontWeight: 600 }}
          />
          <Chip size="small" label={props.contractCount} sx={{ height: 21, fontSize: 9.5 }} />
        </ListItemButton>
      </List>

      <Box sx={{ mt: "auto" }}>
        {/* Mode indicator */}
        <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "rgba(114, 227, 163, .025)", mb: 1.5 }}>
          <Stack direction="row" spacing={1.1}>
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                bgcolor: "primary.main",
                boxShadow: "0 0 0 4px rgba(114,227,163,.09)",
                mt: 0.65,
                flexShrink: 0
              }}
            />
            <Box>
              <Tooltip
                title={`${modeLabel}: ${
                  props.mode === "observe"
                    ? "Plans only — no writes"
                    : props.mode === "approve"
                      ? "All executions require human approval"
                      : "Reversible actions within blast radius auto-execute"
                }`}
                placement="top"
                arrow
              >
                <Typography variant="caption" fontWeight={700} sx={{ cursor: "help" }}>
                  {modeLabel} mode
                </Typography>
              </Tooltip>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mt: 0.45, lineHeight: 1.5 }}
              >
                Typed actions and audit chain healthy.
              </Typography>
            </Box>
          </Stack>
        </Paper>

        {/* User / Logout */}
        <Divider sx={{ mb: 1.5 }} />
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Stack direction="row" alignItems="center" spacing={1}>
            <Avatar sx={{ width: 26, height: 26, bgcolor: "rgba(255,255,255,.07)" }}>
              <PersonRounded sx={{ fontSize: 15 }} />
            </Avatar>
            <Typography variant="caption" fontWeight={650} noWrap sx={{ maxWidth: 120 }}>
              {props.username}
            </Typography>
          </Stack>
          <Tooltip title="Sign out" placement="top">
            <Box
              component="button"
              onClick={props.onLogout}
              aria-label="Sign out"
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 30,
                height: 30,
                borderRadius: 1.5,
                border: "1px solid",
                borderColor: "divider",
                bgcolor: "transparent",
                color: "text.secondary",
                cursor: "pointer",
                "&:hover": { bgcolor: "rgba(255,255,255,.05)", color: "text.primary" }
              }}
            >
              <LogoutRounded sx={{ fontSize: 16 }} />
            </Box>
          </Tooltip>
        </Stack>
      </Box>
    </Box>
  );
}
