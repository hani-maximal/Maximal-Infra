import { useState } from "react";
import { Box, Chip, Collapse, Typography } from "@mui/material";
import type { AuditRecord } from "../types.js";
import { formatLabel } from "../utils.js";

function PayloadRows({ payload }: { payload: unknown }) {
  if (!payload || typeof payload !== "object") return null;
  const entries = Object.entries(payload as Record<string, unknown>);
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(([k, v]) => (
        <Box
          key={k}
          sx={{
            display: "flex",
            justifyContent: "space-between",
            gap: 2,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 11.5
          }}
        >
          <Typography
            component="span"
            sx={{ fontSize: "inherit", fontFamily: "inherit", color: "#7f938a" }}
          >
            {k}
          </Typography>
          <Typography
            component="span"
            sx={{
              fontSize: "inherit",
              fontFamily: "inherit",
              color: "#cbd6d0",
              textAlign: "right",
              overflowWrap: "anywhere"
            }}
          >
            {String(v)}
          </Typography>
        </Box>
      ))}
    </>
  );
}

export function AuditTimeline({ records }: { records: AuditRecord[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (records.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: "center" }}>
        No audit records yet — evaluate the plan to begin.
      </Typography>
    );
  }

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.75 }}>
        Append-only · SHA-256 hash-chained · click any event to inspect its payload
      </Typography>
      <Box component="ol" aria-label="Audit timeline" sx={{ m: 0, p: 0, listStyle: "none" }}>
        {records.map((record, index) => {
          const isOpen = Boolean(expanded[record.id]);
          const isLast = index === records.length - 1;
          const time = new Date(record.ts).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
          });

          return (
            <Box
              key={record.id}
              component="li"
              sx={{ display: "grid", gridTemplateColumns: "20px 1fr" }}
            >
              {/* Rail */}
              <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <Box
                  sx={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    bgcolor: isLast ? "primary.main" : "rgba(255,255,255,.32)",
                    mt: "7px",
                    flexShrink: 0
                  }}
                />
                {!isLast && (
                  <Box sx={{ width: "1px", flex: 1, bgcolor: "rgba(212,230,220,.12)", my: 0.5 }} />
                )}
              </Box>

              {/* Body */}
              <Box sx={{ pl: 1.25, pb: 1.75 }}>
                {/* Header row — clickable */}
                <Box
                  onClick={() => setExpanded((s) => ({ ...s, [record.id]: !s[record.id] }))}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  aria-label={`${formatLabel(record.eventType)} — ${isOpen ? "collapse" : "expand"}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setExpanded((s) => ({ ...s, [record.id]: !s[record.id] }));
                    }
                  }}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 1.25,
                    cursor: "pointer",
                    userSelect: "none"
                  }}
                >
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1.1, minWidth: 0 }}>
                    <Typography sx={{ fontSize: 13, fontWeight: 650 }}>
                      {formatLabel(record.eventType)}
                    </Typography>
                    {record.actor === "human" && (
                      <Chip
                        label="HUMAN"
                        size="small"
                        sx={{
                          height: 18,
                          fontSize: 9.5,
                          fontWeight: 700,
                          letterSpacing: ".05em",
                          bgcolor: "rgba(114,227,163,.1)",
                          color: "#a6f0c4",
                          border: "none"
                        }}
                      />
                    )}
                  </Box>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1.1, flexShrink: 0 }}>
                    <Typography
                      sx={{
                        fontSize: 11.5,
                        color: "#9aafa5",
                        fontFamily: "ui-monospace, Menlo, monospace"
                      }}
                    >
                      {time} · {record.actor}
                    </Typography>
                    <Typography sx={{ fontSize: 11, color: "#6f827a" }}>
                      {isOpen ? "▲" : "▼"}
                    </Typography>
                  </Box>
                </Box>

                {/* Expanded payload */}
                <Collapse in={isOpen}>
                  <Box
                    sx={{
                      mt: 1.25,
                      borderRadius: "10px",
                      border: "1px solid rgba(212,230,220,.1)",
                      bgcolor: "rgba(0,0,0,.22)",
                      overflow: "hidden"
                    }}
                  >
                    <Box sx={{ p: "12px 14px", display: "flex", flexDirection: "column", gap: 0.875 }}>
                      <PayloadRows payload={record.payload} />
                    </Box>
                    <Box
                      sx={{
                        borderTop: "1px solid rgba(212,230,220,.08)",
                        px: "14px",
                        py: "9px",
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        fontFamily: "ui-monospace, Menlo, monospace",
                        fontSize: 10.5,
                        color: "#6f827a"
                      }}
                    >
                      <Typography component="span" sx={{ fontSize: "inherit", color: "primary.main" }}>
                        ⛓
                      </Typography>
                      <Typography component="span" sx={{ fontSize: "inherit", fontFamily: "inherit", color: "inherit" }}>
                        {record.prevHash?.slice(0, 8) ?? "GENESIS"}
                      </Typography>
                      <Typography component="span" sx={{ fontSize: "inherit", fontFamily: "inherit" }}>→</Typography>
                      <Typography component="span" sx={{ fontSize: "inherit", fontFamily: "inherit", color: "#9abaff" }}>
                        {record.hash?.slice(0, 8) ?? "—"}
                      </Typography>
                    </Box>
                  </Box>
                </Collapse>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
