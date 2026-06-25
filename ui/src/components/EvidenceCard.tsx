import { useState } from "react";
import {
  Avatar,
  Box,
  Divider,
  Paper,
  Stack,
  Typography
} from "@mui/material";
import {
  CodeRounded,
  DescriptionOutlined,
  KeyboardArrowDownRounded,
  KeyboardArrowUpRounded,
  LinkRounded,
  SpeedRounded,
  TimelineRounded
} from "@mui/icons-material";
import type { Evidence } from "../types.js";
import { formatLabel } from "../utils.js";

function label(value: string): string {
  return formatLabel(value);
}

export function EvidenceCard({ evidence }: { evidence: Evidence }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = evidence.location || evidence.excerpt || evidence.interpretation || evidence.remediation;

  return (
    <Paper variant="outlined" sx={{ overflow: "hidden", bgcolor: "rgba(255,255,255,.012)" }}>
      {/* Always-visible header row */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.2}
        sx={{
          p: 1.5,
          cursor: hasDetail ? "pointer" : "default",
          userSelect: "none",
          "&:hover": hasDetail ? { bgcolor: "rgba(255,255,255,.025)" } : {}
        }}
        onClick={() => hasDetail && setExpanded((v) => !v)}
        role={hasDetail ? "button" : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        onKeyDown={(e) => {
          if (hasDetail && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        aria-expanded={hasDetail ? expanded : undefined}
        aria-label={hasDetail ? `${label(evidence.kind)} evidence — ${expanded ? "collapse" : "expand"}` : undefined}
      >
        <Avatar sx={{ width: 31, height: 31, bgcolor: "rgba(142, 183, 255, .08)", color: "#9abaff", flexShrink: 0 }}>
          {evidence.kind === "metric" ? (
            <SpeedRounded sx={{ fontSize: 17 }} />
          ) : (
            <TimelineRounded sx={{ fontSize: 17 }} />
          )}
        </Avatar>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
            <Typography variant="caption" color="text.secondary">{label(evidence.kind)}</Typography>
            <Typography variant="caption" color="text.secondary">
              {new Date(evidence.observedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
              })}
            </Typography>
          </Stack>
          <Typography variant="body2" sx={{ mt: 0.25, fontWeight: 650 }}>
            {evidence.summary}
          </Typography>
        </Box>
        {hasDetail && (
          <Box sx={{ color: "text.secondary", flexShrink: 0 }}>
            {expanded ? (
              <KeyboardArrowUpRounded sx={{ fontSize: 18 }} />
            ) : (
              <KeyboardArrowDownRounded sx={{ fontSize: 18 }} />
            )}
          </Box>
        )}
      </Stack>

      {/* Expandable detail */}
      {expanded && (
        <>
          {evidence.location && (
            <Box sx={{ px: 1.5, pb: 1.5 }}>
              <Paper
                variant="outlined"
                sx={{ p: 1.25, bgcolor: "rgba(0,0,0,.16)", borderStyle: "dashed" }}
              >
                <Stack spacing={0.75}>
                  <Stack direction="row" spacing={0.8} alignItems="flex-start">
                    <LinkRounded sx={{ fontSize: 15, color: "text.secondary", mt: 0.15 }} />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="caption" color="text.secondary">
                        Resource
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          display: "block",
                          color: "text.primary",
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          overflowWrap: "anywhere"
                        }}
                      >
                        {evidence.location.resource}
                      </Typography>
                    </Box>
                  </Stack>
                  <Stack direction="row" spacing={0.8} alignItems="flex-start">
                    <DescriptionOutlined sx={{ fontSize: 15, color: "text.secondary", mt: 0.15 }} />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="caption" color="text.secondary">
                        Exact location
                      </Typography>
                      <Typography variant="caption" sx={{ display: "block", color: "text.primary" }}>
                        {evidence.location.source} · {evidence.location.selector}
                      </Typography>
                    </Box>
                  </Stack>
                </Stack>
              </Paper>
            </Box>
          )}

          {evidence.excerpt && (
            <>
              <Divider />
              <Box sx={{ p: 1.5, bgcolor: "#090d0c" }}>
                <Stack direction="row" alignItems="center" spacing={0.7} sx={{ mb: 1 }}>
                  <CodeRounded sx={{ fontSize: 15, color: "primary.main" }} />
                  <Typography
                    variant="caption"
                    color="primary.light"
                    sx={{ letterSpacing: ".08em", fontWeight: 700 }}
                  >
                    PROOF EXCERPT
                  </Typography>
                </Stack>
                <Box
                  component="pre"
                  aria-label="Log excerpt"
                  sx={{
                    m: 0,
                    p: 1.25,
                    overflowX: "auto",
                    borderRadius: 1.5,
                    border: "1px solid",
                    borderColor: "divider",
                    bgcolor: "rgba(0,0,0,.24)",
                    color: "#cbd6d0",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: 11,
                    lineHeight: 1.65,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere"
                  }}
                >
                  {evidence.excerpt}
                </Box>
              </Box>
            </>
          )}

          {(evidence.interpretation || evidence.remediation) && (
            <>
              <Divider />
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }
                }}
              >
                {evidence.interpretation && (
                  <Box
                    sx={{ p: 1.5, borderRight: { md: "1px solid" }, borderColor: "divider" }}
                  >
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontWeight: 700 }}
                    >
                      WHY THIS IS PROOF
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 0.65, lineHeight: 1.6 }}>
                      {evidence.interpretation}
                    </Typography>
                  </Box>
                )}
                {evidence.remediation && (
                  <Box sx={{ p: 1.5, bgcolor: "rgba(114,227,163,.025)" }}>
                    <Typography
                      variant="caption"
                      color="primary.light"
                      sx={{ fontWeight: 700 }}
                    >
                      HOW THE FIX ADDRESSES IT
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        display: "block",
                        mt: 0.65,
                        color: "primary.main",
                        fontFamily: "ui-monospace, monospace"
                      }}
                    >
                      {evidence.remediation.actionType}
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 0.55, lineHeight: 1.6 }}>
                      {evidence.remediation.explanation}
                    </Typography>
                  </Box>
                )}
              </Box>
            </>
          )}
        </>
      )}
    </Paper>
  );
}
