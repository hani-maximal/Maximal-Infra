'use client'
import React, { useEffect, useState, use } from 'react'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Chip from '@mui/material/Chip'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import LinearProgress from '@mui/material/LinearProgress'
import Accordion from '@mui/material/Accordion'
import AccordionSummary from '@mui/material/AccordionSummary'
import AccordionDetails from '@mui/material/AccordionDetails'
import Tooltip from '@mui/material/Tooltip'
import Skeleton from '@mui/material/Skeleton'
import Divider from '@mui/material/Divider'
import Grid from '@mui/material/Grid'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CancelIcon from '@mui/icons-material/Cancel'
import BoltIcon from '@mui/icons-material/Bolt'
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import { api } from '@/lib/api'
import type { Incident, AuditRecord } from '@/lib/types'

const PRIMARY = '#72e3a3'

const STATE_META: Record<string, { color: string; label: string }> = {
  DETECTED:          { color: '#9575cd', label: 'Detected' },
  CLASSIFIED:        { color: '#7986cb', label: 'Classified' },
  CONTRACT_MATCHED:  { color: '#4dd0e1', label: 'Matched' },
  AWAITING_APPROVAL: { color: '#f4b72f', label: 'Awaiting approval' },
  EXECUTING:         { color: '#4db6f5', label: 'Executing' },
  VERIFYING:         { color: '#4db6f5', label: 'Verifying' },
  RESOLVED:          { color: '#72e3a3', label: 'Resolved' },
  ROLLING_BACK:      { color: '#f47272', label: 'Rolling back' },
  ROLLED_BACK:       { color: '#ff9800', label: 'Rolled back' },
  ESCALATED:         { color: '#f47272', label: 'Escalated' },
  CLOSED:            { color: 'rgba(232,245,233,0.3)', label: 'Closed' },
}

const EVIDENCE_COLORS: Record<string, string> = {
  metric: '#4db6f5',
  log: '#ff9800',
  deploy_event: '#72e3a3',
  cloudtrail: '#9575cd',
  alarm: '#f47272',
}

function EvidenceCard({ e }: { e: Incident['evidence'][number] }) {
  return (
    <Card sx={{ border: '1px solid rgba(114,227,163,0.08)', p: 0 }}>
      <CardContent sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" gap={1} sx={{ mb: 1 }}>
          <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: EVIDENCE_COLORS[e.kind] ?? '#888', flexShrink: 0 }} />
          <Chip
            label={e.kind.replace('_', ' ')}
            size="small"
            sx={{ bgcolor: `${EVIDENCE_COLORS[e.kind] ?? '#888'}18`, color: EVIDENCE_COLORS[e.kind] ?? '#888', border: `1px solid ${EVIDENCE_COLORS[e.kind] ?? '#888'}33`, fontSize: '0.65rem', fontWeight: 700 }}
          />
          <Typography variant="caption" color="text.disabled" sx={{ ml: 'auto', fontSize: '0.68rem' }}>
            {new Date(e.observedAt).toLocaleTimeString()}
          </Typography>
        </Stack>
        <Typography variant="body2" sx={{ fontWeight: 600, fontSize: '0.8rem', mb: 0.5 }} noWrap>{e.ref}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.8rem', lineHeight: 1.6 }}>{e.summary}</Typography>
        {e.value !== undefined && (
          <Box sx={{ mt: 1.5, px: 1.5, py: 0.75, bgcolor: 'rgba(0,0,0,0.2)', borderRadius: 1.5, display: 'inline-block' }}>
            <Typography sx={{ fontFamily: 'monospace', fontSize: '0.85rem', fontWeight: 700, color: EVIDENCE_COLORS[e.kind] ?? PRIMARY }}>
              {e.value}
            </Typography>
          </Box>
        )}
      </CardContent>
    </Card>
  )
}

function AuditTimeline({ records }: { records: AuditRecord[] }) {
  const sorted = [...records].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
  return (
    <Stack
      gap={0}
      sx={{
        position: 'relative',
        overflow: 'hidden',
        '&::before': sorted.length > 1
          ? {
              content: '""',
              position: 'absolute',
              left: 10,
              top: 14,
              bottom: 14,
              width: '1px',
              bgcolor: 'rgba(114,227,163,0.16)',
              pointerEvents: 'none',
            }
          : undefined,
      }}
    >
      {sorted.map((r, i) => (
        <Box key={r.id} sx={{ display: 'flex', gap: 2, position: 'relative' }}>
          <Box sx={{ width: 20, flexShrink: 0, position: 'relative', zIndex: 1 }}>
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: r.actor === 'human' ? '#4db6f5' : PRIMARY,
                border: '2px solid #101d18',
                mt: 0.65,
                mx: 'auto',
              }}
            />
          </Box>
          <Box sx={{ pb: i < sorted.length - 1 ? 2.5 : 0 }}>
            <Stack direction="row" alignItems="center" gap={1} sx={{ mb: 0.35 }}>
              <Typography variant="caption" sx={{ fontWeight: 700, fontSize: '0.72rem', color: r.actor === 'human' ? '#4db6f5' : PRIMARY, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {r.eventType.replace(/_/g, ' ')}
              </Typography>
              <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.68rem' }}>
                {new Date(r.ts).toLocaleTimeString()}
              </Typography>
            </Stack>
            {r.actor === 'human' && r.actorId && (
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.72rem' }}>
                by {r.actorId}
              </Typography>
            )}
          </Box>
        </Box>
      ))}
    </Stack>
  )
}

export default function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [incident, setIncident] = useState<Incident | null>(null)
  const [audit, setAudit] = useState<AuditRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<'approve' | 'deny' | 'plan' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function refresh() {
    const [incidents, replay] = await Promise.all([
      api.incidents.list(),
      api.incidents.replay(id).catch(() => ({ valid: false, records: [] })),
    ])
    const inc = incidents.find(i => i.id === id)
    if (inc) setIncident(inc)
    setAudit(replay.records)
    setLoading(false)
  }

  useEffect(() => { refresh() }, [id])

  async function handlePlan() {
    setActionError(null)
    setActionLoading('plan')
    try { await api.incidents.plan(id); await refresh() } catch (e) { setActionError(e instanceof Error ? e.message : 'Failed') }
    setActionLoading(null)
  }

  async function handleApprove() {
    setActionError(null)
    setActionLoading('approve')
    try { await api.incidents.approve(id); await refresh() } catch (e) { setActionError(e instanceof Error ? e.message : 'Failed') }
    setActionLoading(null)
  }

  async function handleDeny() {
    setActionError(null)
    setActionLoading('deny')
    try { await api.incidents.deny(id); await refresh() } catch (e) { setActionError(e instanceof Error ? e.message : 'Failed') }
    setActionLoading(null)
  }

  if (loading) {
    return (
      <Box>
        <Skeleton height={36} width={200} sx={{ mb: 3 }} />
        <Grid container spacing={2.5}>
          <Grid size={{ xs: 12, md: 8 }}><Skeleton height={400} sx={{ borderRadius: 2 }} /></Grid>
          <Grid size={{ xs: 12, md: 4 }}><Skeleton height={400} sx={{ borderRadius: 2 }} /></Grid>
        </Grid>
      </Box>
    )
  }

  if (!incident) {
    return (
      <Box sx={{ textAlign: 'center', py: 10 }}>
        <Typography color="text.secondary">Incident not found.</Typography>
        <Button sx={{ mt: 2 }} onClick={() => router.push('/app/incidents')}>Back to incidents</Button>
      </Box>
    )
  }

  const meta = STATE_META[incident.state] ?? { color: '#888', label: incident.state }
  const canPlan = !incident.plan && !['RESOLVED', 'CLOSED', 'ESCALATED'].includes(incident.state)
  const canApprove = incident.state === 'AWAITING_APPROVAL' && incident.plan?.decision === 'APPROVE'
  const canDeny = incident.state === 'AWAITING_APPROVAL'

  return (
    <Box>
      {/* Header */}
      <Stack direction="row" alignItems="center" gap={2} sx={{ mb: 3 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push('/app/incidents')}
          variant="text"
          size="small"
          sx={{ color: 'text.secondary' }}
        >
          Incidents
        </Button>
        <Typography color="text.disabled">/</Typography>
        <Typography variant="body2" color="text.secondary" noWrap sx={{ maxWidth: 200 }}>{incident.service}</Typography>
        <Chip
          label={meta.label}
          size="small"
          sx={{ ml: 'auto', bgcolor: `${meta.color}18`, color: meta.color, border: `1px solid ${meta.color}44`, fontWeight: 700, fontSize: '0.72rem' }}
        />
      </Stack>

      <Typography variant="h5" sx={{ fontWeight: 700, letterSpacing: '-0.02em', mb: 0.75 }}>
        {incident.service} — {incident.type.replace(/_/g, ' ')}
      </Typography>
      <Stack direction="row" gap={2} flexWrap="wrap" sx={{ mb: 3 }}>
        <Typography variant="body2" color="text.secondary">{incident.environment}</Typography>
        <Typography color="text.disabled" variant="body2">·</Typography>
        <Typography variant="body2" color="text.secondary">Source: {incident.source}</Typography>
        <Typography color="text.disabled" variant="body2">·</Typography>
        <Typography variant="body2" color="text.secondary">{new Date(incident.createdAt).toLocaleString()}</Typography>
      </Stack>

      {actionError && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>{actionError}</Alert>}

      <Grid container spacing={2.5}>
        {/* Left column */}
        <Grid size={{ xs: 12, md: 8 }}>
          <Stack gap={2.5}>
            {/* Confidence */}
            <Card>
              <CardContent sx={{ p: 2.5 }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
                  <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '0.9rem' }}>Confidence score</Typography>
                  <Typography sx={{ fontWeight: 800, fontSize: '1.5rem', color: incident.confidence >= 0.9 ? PRIMARY : '#f4b72f', letterSpacing: '-0.02em' }}>
                    {Math.round(incident.confidence * 100)}%
                  </Typography>
                </Stack>
                <LinearProgress
                  variant="determinate"
                  value={incident.confidence * 100}
                  sx={{
                    height: 8, borderRadius: 4,
                    '& .MuiLinearProgress-bar': {
                      bgcolor: incident.confidence >= 0.9 ? PRIMARY : incident.confidence >= 0.75 ? '#f4b72f' : '#f47272',
                    },
                  }}
                />
                <Stack direction="row" justifyContent="space-between" sx={{ mt: 1 }}>
                  <Typography variant="caption" color="text.disabled">0%</Typography>
                  <Typography variant="caption" color="text.disabled" sx={{ ml: 'auto' }}>Floor: 90%</Typography>
                </Stack>
              </CardContent>
            </Card>

            {/* Policy decision */}
            {incident.plan && (
              <Alert
                severity={incident.plan.decision === 'AUTO' ? 'success' : incident.plan.decision === 'APPROVE' ? 'warning' : 'error'}
                icon={incident.plan.decision === 'AUTO' ? <BoltIcon /> : incident.plan.decision === 'APPROVE' ? <HourglassEmptyIcon /> : <WarningAmberIcon />}
                sx={{ borderRadius: 2 }}
              >
                <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>
                  Policy decision: {incident.plan.decision} — {incident.plan.actionType.replace(/_/g, ' ')}
                </Typography>
                <Stack gap={0.4}>
                  {incident.plan.reasons.map((r, i) => (
                    <Typography key={i} variant="caption" sx={{ display: 'block', opacity: 0.85 }}>{r}</Typography>
                  ))}
                </Stack>
              </Alert>
            )}

            {/* Action buttons */}
            <Card>
              <CardContent sx={{ p: 2.5 }}>
                <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '0.9rem', mb: 2 }}>Actions</Typography>
                <Stack direction="row" gap={1.5} flexWrap="wrap">
                  {canPlan && (
                    <Button
                      variant="outlined"
                      startIcon={<BoltIcon />}
                      onClick={handlePlan}
                      disabled={actionLoading !== null}
                    >
                      {actionLoading === 'plan' ? 'Planning…' : 'Evaluate policy'}
                    </Button>
                  )}
                  {canApprove && (
                    <Button
                      variant="contained"
                      color="success"
                      startIcon={<CheckCircleIcon />}
                      onClick={handleApprove}
                      disabled={actionLoading !== null}
                      sx={{ bgcolor: PRIMARY, '&:hover': { bgcolor: '#86e9b0' } }}
                    >
                      {actionLoading === 'approve' ? 'Executing…' : 'Approve & execute'}
                    </Button>
                  )}
                  {canDeny && (
                    <Button
                      variant="outlined"
                      color="error"
                      startIcon={<CancelIcon />}
                      onClick={handleDeny}
                      disabled={actionLoading !== null}
                    >
                      {actionLoading === 'deny' ? 'Denying…' : 'Deny'}
                    </Button>
                  )}
                  {!canPlan && !canApprove && !canDeny && (
                    <Typography variant="body2" color="text.secondary">
                      {['RESOLVED', 'CLOSED'].includes(incident.state) ? 'Incident resolved — no further actions needed.' : 'No actions available in this state.'}
                    </Typography>
                  )}
                </Stack>
              </CardContent>
            </Card>

            {/* Evidence */}
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '0.9rem', mb: 1.5 }}>
                Evidence ({incident.evidence.length})
              </Typography>
              <Grid container spacing={1.5}>
                {incident.evidence.map((e, i) => (
                  <Grid key={i} size={{ xs: 12, sm: 6 }}>
                    <EvidenceCard e={e} />
                  </Grid>
                ))}
              </Grid>
            </Box>

            {/* Deploy correlation */}
            {incident.deployCorrelation && (
              <Card>
                <CardContent sx={{ p: 2.5 }}>
                  <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '0.9rem', mb: 1.5 }}>Deploy correlation</Typography>
                  <Stack gap={1}>
                    {[
                      { label: 'Deploy ID', value: incident.deployCorrelation.deployId },
                      { label: 'Deployed at', value: new Date(incident.deployCorrelation.deployedAt).toLocaleString() },
                      { label: 'Artifact', value: incident.deployCorrelation.artifactRef },
                    ].map(row => (
                      <Stack key={row.label} direction="row" gap={2} alignItems="baseline">
                        <Typography variant="caption" color="text.disabled" sx={{ minWidth: 90 }}>{row.label}</Typography>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8rem', wordBreak: 'break-all' }}>{row.value}</Typography>
                      </Stack>
                    ))}
                  </Stack>
                </CardContent>
              </Card>
            )}
          </Stack>
        </Grid>

        {/* Right column — Audit timeline */}
        <Grid size={{ xs: 12, md: 4 }}>
          <Card sx={{ position: { md: 'sticky' }, top: { md: 68 } }}>
            <CardContent sx={{ p: 2.5 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
                <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '0.9rem' }}>Audit trail</Typography>
                <Chip label={`${audit.length} events`} size="small" sx={{ bgcolor: 'rgba(114,227,163,0.08)', color: PRIMARY, border: '1px solid rgba(114,227,163,0.2)', fontSize: '0.68rem' }} />
              </Stack>
              {audit.length === 0 ? (
                <Typography variant="body2" color="text.secondary">No audit records yet. Evaluate the policy to start.</Typography>
              ) : (
                <Box sx={{ maxHeight: 500, overflowY: 'auto' }}>
                  <AuditTimeline records={audit} />
                </Box>
              )}
              {audit.length > 0 && (
                <>
                  <Divider sx={{ my: 2 }} />
                  <Tooltip title="SHA-256 hash-chained records. Every event references the previous hash.">
                    <Stack direction="row" alignItems="center" gap={1}>
                      <CheckCircleIcon sx={{ fontSize: 14, color: PRIMARY }} />
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.68rem' }}>
                        Chain integrity verified · {audit.length} records
                      </Typography>
                    </Stack>
                  </Tooltip>
                </>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  )
}
