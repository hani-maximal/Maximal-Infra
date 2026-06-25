import { Component, type ErrorInfo, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Alert, Box, Button, Stack, Typography, CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import App from "./App.js";
import "./index.css";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#72e3a3",
      light: "#a6f0c4",
      dark: "#34c978",
      contrastText: "#07100b"
    },
    background: {
      default: "#090d0c",
      paper: "#111614"
    },
    text: {
      primary: "#f4f7f5",
      secondary: "#9aafa5"
    },
    divider: "rgba(212, 230, 220, 0.09)",
    warning: { main: "#f5c76d" },
    error: { main: "#ff8d8d" },
    success: { main: "#72e3a3" }
  },
  shape: { borderRadius: 14 },
  typography: {
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    h1: { fontSize: "2.15rem", lineHeight: 1.08, fontWeight: 680, letterSpacing: "-0.045em" },
    h2: { fontSize: "1.15rem", lineHeight: 1.3, fontWeight: 650, letterSpacing: "-0.02em" },
    h3: { fontSize: "0.95rem", lineHeight: 1.35, fontWeight: 650 },
    button: { textTransform: "none", fontWeight: 650 }
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { colorScheme: "dark" }
      }
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: 10, minHeight: 38, paddingInline: 15 }
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: "none" }
      }
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 650 }
      }
    }
  }
});

// ────────────────────────────────────────────────────────────────
// Error boundary
// ────────────────────────────────────────────────────────────────
interface BoundaryState {
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Maximal] Unhandled render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <Stack
            alignItems="center"
            justifyContent="center"
            sx={{ minHeight: "100vh", p: 4, textAlign: "center" }}
          >
            <Alert severity="error" variant="outlined" sx={{ maxWidth: 520, width: "100%", mb: 3 }}>
              <Typography variant="h3" sx={{ mb: 1 }}>
                Something went wrong
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ fontFamily: "ui-monospace, monospace", fontSize: 11, mt: 1 }}>
                {this.state.error.message}
              </Typography>
            </Alert>
            <Box>
              <Button variant="outlined" onClick={() => this.setState({ error: null })}>
                Try again
              </Button>
              <Button
                variant="text"
                color="inherit"
                sx={{ ml: 1 }}
                onClick={() => window.location.reload()}
              >
                Reload page
              </Button>
            </Box>
          </Stack>
        </ThemeProvider>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>
);
