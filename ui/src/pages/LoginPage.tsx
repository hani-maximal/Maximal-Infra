import { useState } from "react";
import {
  Alert,
  Avatar,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  TextField,
  Typography
} from "@mui/material";
import { LockRounded, SecurityRounded } from "@mui/icons-material";
import { api } from "../api.js";

const surface = {
  border: "1px solid",
  borderColor: "divider",
  bgcolor: "rgba(17, 22, 20, 0.82)",
  backdropFilter: "blur(18px)"
};

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        px: 2
      }}
    >
      <Paper sx={{ ...surface, width: "100%", maxWidth: 400, p: { xs: 3, sm: 4 } }}>
        <Stack alignItems="center" spacing={1.5} sx={{ mb: 4 }}>
          <Avatar
            variant="rounded"
            sx={{
              width: 48,
              height: 48,
              bgcolor: "rgba(114, 227, 163, .11)",
              color: "primary.light",
              border: "1px solid rgba(114, 227, 163, .25)"
            }}
          >
            <SecurityRounded sx={{ fontSize: 24 }} />
          </Avatar>
          <Box sx={{ textAlign: "center" }}>
            <Typography fontWeight={720} fontSize={20} letterSpacing="-.02em">
              Maximal
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Safe execution control plane
            </Typography>
          </Box>
        </Stack>

        <Box component="form" onSubmit={handleSubmit} noValidate>
          <Stack spacing={2}>
            <TextField
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              fullWidth
              size="small"
              disabled={busy}
              inputProps={{ "aria-label": "Username" }}
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              fullWidth
              size="small"
              disabled={busy}
              inputProps={{ "aria-label": "Password" }}
            />
            {error && (
              <Alert severity="error" variant="outlined" sx={{ py: 0.5 }}>
                {error}
              </Alert>
            )}
            <Button
              type="submit"
              variant="contained"
              fullWidth
              disabled={busy || !username || !password}
              startIcon={
                busy ? (
                  <CircularProgress size={15} color="inherit" />
                ) : (
                  <LockRounded sx={{ fontSize: 17 }} />
                )
              }
              sx={{ mt: 0.5 }}
            >
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </Stack>
        </Box>
      </Paper>
    </Box>
  );
}
