'use client'
import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Grid from '@mui/material/Grid'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Typography from '@mui/material/Typography'
import Stack from '@mui/material/Stack'
import Chip from '@mui/material/Chip'
import LinearProgress from '@mui/material/LinearProgress'
import Skeleton from '@mui/material/Skeleton'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import PendingActionsIcon from '@mui/icons-material/PendingActions'
import TimelineIcon from '@mui/icons-material/Timeline'
import { api } from '@/lib/api'
import type { Incident } from '@/lib/types'

const PRIMARY = '#72e3a3'

function StatCard({ label, value, sub, color, icon }: { label: string; value: string | number; sub?: string; color?: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent sx={{ p: 2.5 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.7rem', fontWeight: 600 }}>
              {label}
            </Typography>
            <Typography sx={{ fontSize: '2rem', fontWeight: 800, letterSpacing: '-0.03em', color: color ?? 'text.primary', lineHeight: 1.2, mt: 0.5 }}>
              {value}
            </Typography>
            {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
          </Box>
          <Box sx={{ color: color ?? 'text.secondary', mt: 0.25, opacity: 0.8 }}>{icon}</Box>
        </Stack>
      </CardContent>
    </Card>
  )
}

const STATE_COLOR: Record<string, string> = {
  AWAITING_APPROVAL: '#f4b72f',
  EXECUTING: '#4db6f5',
  VERIFYING: '#4db6f5',
  ROLLING_BACK: '#f47272',
  ESCALATED: '#f47272',
  RESOLVED: '#72e3a3',
  CLOSED: 'rgba(232,245,233,0.3)',
  DETECTED: '#9575cd',
  CLASSIFIED: '#7986cb',
  CONTRACT_MATCHED: '#4dd0e1',
}

export default function OverviewPage() {
  const router = useRouter()
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [health, setHealth] = useState<{ ok: boolean; mode: string; contracts: number; chainValid: boolean } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([api.incidents.list(), api.health()])
      .then(([inc, h]) => { setIncidents(inc); setHealth(h) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const active = incidents.filter(i => !['RESOLVED', 'CLOSED', 'ESCALATED'].includes(i.state))
  const awaiting = incidents.filter(i => i.state === 'AWAITING_APPROVAL')
  const resolved = incidents.filter(i => i.state === 'RESOLVED')
  const recent = [...incidents].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5)

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, letterSpacing: '-0.02em' }}>Overview</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Control plane status and recent activity.
        </Typography>
      </Box>

      {/* Stats */}
      <Grid container spacing={2.5} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          {loading ? <Skeleton variant="rectangular" height={100} sx={{ borderRadius: 2 }} /> :
            <StatCard label="Active incidents" value={active.length} color={active.length > 0 ? '#f4b72f' : PRIMARY} icon={<WarningAmberIcon />} />}
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          {loading ? <Skeleton variant="rectangular" height={100} sx={{ borderRadius: 2 }} /> :
            <StatCard label="Awaiting approval" value={awaiting.length} color={awaiting.length > 0 ? '#4db6f5' : 'text.secondary'} icon={<PendingActionsIcon />} />}
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          {loading ? <Skeleton variant="rectangular" height={100} sx={{ borderRadius: 2 }} /> :
            <StatCard label="Resolved today" value={resolved.length} color={PRIMARY} icon={<CheckCircleIcon />} />}
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          {loading ? <Skeleton variant="rectangular" height={100} sx={{ borderRadius: 2 }} /> :
            <StatCard label="Contracts loaded" value={health?.contracts ?? '—'} sub={health?.chainValid ? 'Chain valid' : undefined} color={PRIMARY} icon={<TimelineIcon />} />}
        </Grid>
      </Grid>

      <Grid container spacing={2.5}>
        {/* Recent incidents */}
        <Grid size={{ xs: 12, md: 8 }}>
          <Card>
            <CardContent sx={{ p: 2.5 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
                <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '0.95rem' }}>Recent incidents</Typography>
                <Typography
                  variant="body2"
                  sx={{ color: PRIMARY, cursor: 'pointer', fontWeight: 600, fontSize: '0.8rem' }}
                  onClick={() => router.push('/app/incidents')}
                >
                  View all →
                </Typography>
              </Stack>

              {loading ? (
                <Stack gap={1.5}>{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} height={44} sx={{ borderRadius: 1.5 }} />)}</Stack>
              ) : recent.length === 0 ? (
                <Box sx={{ py: 6, textAlign: 'center' }}>
                  <Typography color="text.secondary" variant="body2">No incidents yet. Connect an AWS account to start monitoring.</Typography>
                </Box>
              ) : (
                <Stack gap={0}>
                  {recent.map((inc, i) => (
                    <Box
                      key={inc.id}
                      onClick={() => router.push(`/app/incidents/${inc.id}`)}
                      sx={{
                        display: 'flex', alignItems: 'center', gap: 2,
                        py: 1.25, px: 1.5, borderRadius: 2, cursor: 'pointer',
                        '&:hover': { bgcolor: 'rgba(114,227,163,0.05)' },
                        borderBottom: i < recent.length - 1 ? '1px solid rgba(114,227,163,0.07)' : 'none',
                      }}
                    >
                      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: STATE_COLOR[inc.state] ?? 'text.disabled', flexShrink: 0 }} />
                      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600, fontSize: '0.83rem' }} noWrap>
                          {inc.service} — {inc.type.replace(/_/g, ' ')}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">{inc.environment} · {new Date(inc.createdAt).toLocaleTimeString()}</Typography>
                      </Box>
                      <Chip
                        label={inc.state.replace(/_/g, ' ')}
                        size="small"
                        sx={{ bgcolor: `${STATE_COLOR[inc.state] ?? '#888'}22`, color: STATE_COLOR[inc.state] ?? 'text.secondary', border: `1px solid ${STATE_COLOR[inc.state] ?? '#888'}44`, fontSize: '0.68rem', fontWeight: 700 }}
                      />
                    </Box>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* System health */}
        <Grid size={{ xs: 12, md: 4 }}>
          <Card sx={{ height: '100%' }}>
            <CardContent sx={{ p: 2.5 }}>
              <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '0.95rem', mb: 2 }}>System health</Typography>
              <Stack gap={2}>
                {[
                  { label: 'Engine', ok: health?.ok ?? null },
                  { label: 'Audit chain', ok: health?.chainValid ?? null },
                  { label: 'Contracts', ok: (health?.contracts ?? 0) > 0 },
                ].map(row => (
                  <Stack key={row.label} direction="row" justifyContent="space-between" alignItems="center">
                    <Typography variant="body2" color="text.secondary">{row.label}</Typography>
                    {loading || row.ok === null ? (
                      <Skeleton width={48} height={20} sx={{ borderRadius: 1 }} />
                    ) : (
                      <Chip
                        label={row.ok ? 'OK' : 'Error'}
                        size="small"
                        sx={{
                          bgcolor: row.ok ? 'rgba(114,227,163,0.1)' : 'rgba(244,114,114,0.1)',
                          color: row.ok ? PRIMARY : '#f47272',
                          border: `1px solid ${row.ok ? 'rgba(114,227,163,0.25)' : 'rgba(244,114,114,0.25)'}`,
                          fontSize: '0.68rem', fontWeight: 700,
                        }}
                      />
                    )}
                  </Stack>
                ))}
                <Box sx={{ mt: 1 }}>
                  <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.75 }}>
                    <Typography variant="caption" color="text.secondary">Autonomy mode</Typography>
                    <Typography variant="caption" sx={{ fontWeight: 600, color: PRIMARY, textTransform: 'uppercase' }}>
                      {loading ? '—' : health?.mode ?? '—'}
                    </Typography>
                  </Stack>
                  <LinearProgress
                    variant={loading ? 'indeterminate' : 'determinate'}
                    value={health?.mode === 'observe' ? 33 : health?.mode === 'approve' ? 66 : 100}
                    color="primary"
                  />
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  )
}
