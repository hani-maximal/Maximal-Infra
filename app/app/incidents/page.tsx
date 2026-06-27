'use client'
import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Stack from '@mui/material/Stack'
import Chip from '@mui/material/Chip'
import Card from '@mui/material/Card'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import InputAdornment from '@mui/material/InputAdornment'
import LinearProgress from '@mui/material/LinearProgress'
import Tooltip from '@mui/material/Tooltip'
import Skeleton from '@mui/material/Skeleton'
import SearchIcon from '@mui/icons-material/Search'
import AddIcon from '@mui/icons-material/Add'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import { api } from '@/lib/api'
import type { Incident } from '@/lib/types'

const PRIMARY = '#72e3a3'

const STATE_META: Record<string, { label: string; color: string }> = {
  DETECTED:          { label: 'Detected',         color: '#9575cd' },
  CLASSIFIED:        { label: 'Classified',        color: '#7986cb' },
  CONTRACT_MATCHED:  { label: 'Matched',           color: '#4dd0e1' },
  AWAITING_APPROVAL: { label: 'Awaiting approval', color: '#f4b72f' },
  EXECUTING:         { label: 'Executing',         color: '#4db6f5' },
  VERIFYING:         { label: 'Verifying',         color: '#4db6f5' },
  RESOLVED:          { label: 'Resolved',          color: '#72e3a3' },
  ROLLING_BACK:      { label: 'Rolling back',      color: '#f47272' },
  ROLLED_BACK:       { label: 'Rolled back',       color: '#ff9800' },
  ESCALATED:         { label: 'Escalated',         color: '#f47272' },
  CLOSED:            { label: 'Closed',            color: 'rgba(232,245,233,0.28)' },
}

const FILTERS = ['All', 'Active', 'Awaiting approval', 'Resolved', 'Escalated'] as const
type IncidentFilter = typeof FILTERS[number]

const ACTIVE_STATES = ['DETECTED', 'CLASSIFIED', 'CONTRACT_MATCHED', 'EXECUTING', 'VERIFYING', 'ROLLING_BACK', 'ROLLED_BACK']
const RESOLVED_STATES = ['RESOLVED', 'CLOSED']

function matchesFilter(incident: Incident, filter: IncidentFilter) {
  if (filter === 'All') return true
  if (filter === 'Active') return ACTIVE_STATES.includes(incident.state)
  if (filter === 'Awaiting approval') return incident.state === 'AWAITING_APPROVAL'
  if (filter === 'Resolved') return RESOLVED_STATES.includes(incident.state)
  if (filter === 'Escalated') return incident.state === 'ESCALATED'
  return true
}

function StateChip({ state }: { state: string }) {
  const meta = STATE_META[state] ?? { label: state, color: '#888' }
  return (
    <Chip
      label={meta.label}
      size="small"
      sx={{
        bgcolor: `${meta.color}18`,
        color: meta.color,
        border: `1px solid ${meta.color}44`,
        fontWeight: 700,
        fontSize: '0.68rem',
        letterSpacing: '0.02em',
      }}
    />
  )
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 0.9 ? PRIMARY : value >= 0.75 ? '#f4b72f' : '#f47272'
  return (
    <Tooltip title={`${Math.round(value * 100)}% confidence`} placement="top">
      <Stack direction="row" alignItems="center" gap={1}>
        <LinearProgress
          variant="determinate"
          value={value * 100}
          sx={{
            width: 60, height: 5,
            bgcolor: 'rgba(255,255,255,0.08)',
            '& .MuiLinearProgress-bar': { bgcolor: color },
          }}
        />
        <Typography variant="caption" sx={{ color, fontWeight: 600, fontSize: '0.72rem', minWidth: 28 }}>
          {Math.round(value * 100)}%
        </Typography>
      </Stack>
    </Tooltip>
  )
}

export default function IncidentsPage() {
  const router = useRouter()
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<IncidentFilter>('All')
  const [search, setSearch] = useState('')
  const [spawning, setSpawning] = useState(false)

  async function refresh() {
    setLoading(true)
    api.incidents.list().then(setIncidents).catch(() => {}).finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [])

  async function spawnDemo() {
    setSpawning(true)
    try {
      const incident = await api.incidents.demo()
      await refresh()
      router.push(`/app/incidents/${incident.id}`)
    } catch {}
    setSpawning(false)
  }

  const filtered = incidents.filter(inc => {
    const matchSearch = search === '' || inc.service.toLowerCase().includes(search.toLowerCase()) || inc.type.toLowerCase().includes(search.toLowerCase())
    const matchFilter = matchesFilter(inc, filter)
    return matchSearch && matchFilter
  })

  const sorted = [...filtered].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  const filterCounts = Object.fromEntries(FILTERS.map(f => [f, incidents.filter(inc => matchesFilter(inc, f)).length])) as Record<IncidentFilter, number>
  const activeCount = incidents.filter(inc => matchesFilter(inc, 'Active')).length

  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} gap={2} sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700, letterSpacing: '-0.02em' }}>Incidents</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {incidents.length} total / {activeCount} active
          </Typography>
        </Box>
        <Button variant="outlined" size="small" startIcon={<AddIcon />} onClick={spawnDemo} disabled={spawning}>
          {spawning ? 'Creating…' : 'Demo incident'}
        </Button>
      </Stack>

      {/* Filters + search */}
      <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} sx={{ mb: 2.5 }}>
        <Stack direction="row" gap={1} flexWrap="wrap">
          {FILTERS.map(f => (
            <Chip
              key={f}
              label={`${f} ${filterCounts[f]}`}
              onClick={() => setFilter(f)}
              variant={filter === f ? 'filled' : 'outlined'}
              size="small"
              sx={{
                cursor: 'pointer',
                ...(filter === f
                  ? { bgcolor: 'rgba(114,227,163,0.15)', color: PRIMARY, border: '1px solid rgba(114,227,163,0.35)', fontWeight: 700 }
                  : { borderColor: 'rgba(114,227,163,0.18)', color: 'text.secondary' }),
              }}
            />
          ))}
        </Stack>
        <TextField
          size="small"
          placeholder="Search service or type…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          sx={{ ml: 'auto', minWidth: 220 }}
          slotProps={{
            input: {
              startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18, color: 'text.disabled' }} /></InputAdornment>,
            }
          }}
        />
      </Stack>

      {/* Table */}
      <Card sx={{ overflow: 'hidden' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Service</TableCell>
              <TableCell>Incident type</TableCell>
              <TableCell>Environment</TableCell>
              <TableCell>Confidence</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Created</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 7 }).map((__, j) => (
                    <TableCell key={j}><Skeleton height={20} /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : sorted.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <Box sx={{ py: 6, textAlign: 'center' }}>
                    <Typography color="text.secondary" variant="body2">
                      {incidents.length === 0
                        ? 'No incidents yet. Click "Demo incident" to create a synthetic one.'
                        : 'No incidents match the current filters.'}
                    </Typography>
                  </Box>
                </TableCell>
              </TableRow>
            ) : (
              sorted.map(inc => (
                <TableRow
                  key={inc.id}
                  hover
                  sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'rgba(114,227,163,0.04)' } }}
                  onClick={() => router.push(`/app/incidents/${inc.id}`)}
                >
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600, fontSize: '0.83rem' }}>{inc.service}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.83rem' }}>
                      {inc.type.replace(/_/g, ' ')}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={inc.environment}
                      size="small"
                      sx={{
                        bgcolor: inc.environment === 'production' ? 'rgba(244,114,114,0.12)' : 'rgba(114,227,163,0.08)',
                        color: inc.environment === 'production' ? '#f47272' : PRIMARY,
                        border: `1px solid ${inc.environment === 'production' ? 'rgba(244,114,114,0.25)' : 'rgba(114,227,163,0.2)'}`,
                        fontSize: '0.68rem', fontWeight: 700,
                      }}
                    />
                  </TableCell>
                  <TableCell><ConfidenceBar value={inc.confidence} /></TableCell>
                  <TableCell><StateChip state={inc.state} /></TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {new Date(inc.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <OpenInNewIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </Box>
  )
}
