'use client'
import React, { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Chip from '@mui/material/Chip'
import TextField from '@mui/material/TextField'
import InputAdornment from '@mui/material/InputAdornment'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import IconButton from '@mui/material/IconButton'
import Divider from '@mui/material/Divider'
import Grid from '@mui/material/Grid'
import Skeleton from '@mui/material/Skeleton'
import Tooltip from '@mui/material/Tooltip'
import SearchIcon from '@mui/icons-material/Search'
import CloseIcon from '@mui/icons-material/Close'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { api } from '@/lib/api'
import type { Contract } from '@/lib/types'

const PRIMARY = '#72e3a3'

const TYPE_GROUPS: Record<string, string> = {
  post_deploy_5xx_spike: 'Deployments',
  deploy_failed_or_stuck: 'Deployments',
  ecs_service_unhealthy: 'ECS / Fargate',
  fargate_service_unhealthy: 'ECS / Fargate',
  fargate_task_oom_kill: 'ECS / Fargate',
  ecs_image_pull_failed: 'ECS / Fargate',
  ecs_task_placement_capacity_failed: 'ECS / Fargate',
  lambda_error_spike: 'Lambda',
  lambda_throttling_concurrency_exhausted: 'Lambda',
  lambda_timeout_duration_spike: 'Lambda',
  alb_latency_saturation: 'Networking',
  alb_target_unhealthy_no_deploy: 'Networking',
  dependency_5xx_timeout_spike: 'Networking',
  ec2_asg_unhealthy_hosts: 'EC2',
  ec2_disk_full: 'EC2',
  ec2_instance_status_check_failed: 'EC2',
  eks_deployment_rollout_failed: 'EKS',
  eks_node_not_ready: 'EKS',
  rds_connection_saturation: 'Data stores',
  elasticache_memory_pressure_evictions: 'Data stores',
  sqs_worker_backlog_saturation: 'Data stores',
  lightsail_container_deployment_failed: 'Lightsail',
  lightsail_instance_unhealthy: 'Lightsail',
}

function ApprovalBadge({ mode }: { mode: string }) {
  return (
    <Chip
      label={mode === 'always_human' ? 'Always human' : 'Auto within limits'}
      size="small"
      sx={{
        bgcolor: mode === 'always_human' ? 'rgba(244,183,47,0.12)' : 'rgba(114,227,163,0.10)',
        color: mode === 'always_human' ? '#f4b72f' : PRIMARY,
        border: `1px solid ${mode === 'always_human' ? 'rgba(244,183,47,0.28)' : 'rgba(114,227,163,0.22)'}`,
        fontSize: '0.65rem',
        fontWeight: 700,
      }}
    />
  )
}

function HelpText({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.45, lineHeight: 1.55 }}>
      {children}
    </Typography>
  )
}

function SectionHeading({ title, help }: { title: string; help: React.ReactNode }) {
  return (
    <Box sx={{ mb: 0.75 }}>
      <Typography variant="overline" sx={{ color: 'text.disabled', fontSize: '0.68rem', lineHeight: 1.4 }}>
        {title}
      </Typography>
      <HelpText>{help}</HelpText>
    </Box>
  )
}

function ContractCard({ contract, onClick }: { contract: Contract; onClick: () => void }) {
  const group = TYPE_GROUPS[contract.incidentType] ?? 'Other'
  return (
    <Card
      onClick={onClick}
      sx={{
        cursor: 'pointer',
        transition: 'border-color 0.18s, box-shadow 0.18s',
        '&:hover': { borderColor: 'rgba(114,227,163,0.30)', boxShadow: '0 0 0 1px rgba(114,227,163,0.10)' },
      }}
    >
      <CardContent sx={{ p: 2.5 }}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={1} sx={{ mb: 1.5 }}>
          <Box>
            <Chip label={group} size="small"
              sx={{ bgcolor: 'rgba(114,227,163,0.07)', color: 'rgba(114,227,163,0.7)', border: '1px solid rgba(114,227,163,0.15)', fontSize: '0.65rem', fontWeight: 600, mb: 1 }} />
            <Typography variant="body1" sx={{ fontWeight: 700, fontSize: '0.85rem', lineHeight: 1.35 }}>
              {contract.incidentType.replace(/_/g, ' ')}
            </Typography>
          </Box>
          <CheckCircleIcon sx={{ fontSize: 18, color: PRIMARY, flexShrink: 0, mt: 0.25 }} />
        </Stack>

        <Stack direction="row" alignItems="center" gap={1} sx={{ mb: 1.5 }}>
          <ApprovalBadge mode={contract.approval.mode} />
          <Typography variant="caption" color="text.disabled">≥{Math.round(contract.minConfidence * 100)}% confidence</Typography>
        </Stack>

        <Divider sx={{ mb: 1.5 }} />

        <Typography variant="caption" color="text.disabled" sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.65rem', fontWeight: 600, display: 'block', mb: 0.75 }}>
          Allowed actions
        </Typography>
        <Stack gap={0.5}>
          {contract.allowedActions.slice(0, 3).map(a => (
            <Typography key={a} variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>
              · {a}
            </Typography>
          ))}
          {contract.allowedActions.length > 3 && (
            <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.72rem' }}>
              +{contract.allowedActions.length - 3} more
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  )
}

function ContractDetail({ contract, onClose }: { contract: Contract; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pr: 6 }}>
        <Typography sx={{ fontWeight: 700, letterSpacing: '-0.02em', fontSize: '1.05rem' }}>
          {contract.incidentType.replace(/_/g, ' ')}
        </Typography>
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 16, top: 12 }} size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack gap={3}>
          <Stack direction="row" gap={2} flexWrap="wrap">
            <ApprovalBadge mode={contract.approval.mode} />
            <Chip label={`≥${Math.round(contract.minConfidence * 100)}% confidence`} size="small"
              sx={{ bgcolor: 'rgba(114,227,163,0.08)', color: PRIMARY, border: '1px solid rgba(114,227,163,0.2)', fontSize: '0.68rem' }} />
            <Chip label={`Window: ${contract.verify.window}`} size="small"
              sx={{ bgcolor: 'rgba(77,182,245,0.08)', color: '#4db6f5', border: '1px solid rgba(77,182,245,0.2)', fontSize: '0.68rem' }} />
          </Stack>

          <Box sx={{ p: 1.5, bgcolor: 'rgba(114,227,163,0.055)', borderRadius: 2, border: '1px solid rgba(114,227,163,0.12)' }}>
            <Stack direction="row" gap={1.1} alignItems="flex-start">
              <InfoOutlinedIcon sx={{ fontSize: 16, color: PRIMARY, mt: 0.15, flexShrink: 0 }} />
              <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.6 }}>
                This contract is the safety rulebook for this incident pattern: what evidence we trust,
                what actions are allowed, how small the change must stay, and how we prove the service
                recovered afterward.
              </Typography>
            </Stack>
          </Box>

          <Box>
            <SectionHeading
              title="Sources"
              help="Signals that can support this diagnosis. We require known sources so automation is based on corroborated telemetry, not a single ambiguous alert."
            />
            <Stack direction="row" gap={0.75} flexWrap="wrap" sx={{ mt: 0.75 }}>
              {contract.source.map(s => (
                <Chip key={s} label={s.replace(/_/g, ' ')} size="small"
                  sx={{ bgcolor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.68rem' }} />
              ))}
            </Stack>
          </Box>

          <Box>
            <SectionHeading
              title="Allowed actions"
              help="The only typed remediation functions this contract may run. Anything outside this list is blocked and escalated."
            />
            <Stack gap={0.5} sx={{ mt: 0.75 }}>
              {contract.allowedActions.map(a => (
                <Box key={a} sx={{ px: 1.25, py: 0.6, bgcolor: 'rgba(0,0,0,0.25)', borderRadius: 1.5, border: '1px solid rgba(114,227,163,0.08)' }}>
                  <Typography sx={{ fontFamily: 'monospace', fontSize: '0.8rem', color: PRIMARY }}>{a}</Typography>
                </Box>
              ))}
            </Stack>
          </Box>

          <Box>
            <SectionHeading
              title="Blast radius"
              help="Hard limits on scope. We keep automated changes small, environment-aware, and reversible so a fix cannot become a wider outage."
            />
            <Stack gap={0.5} sx={{ mt: 0.75 }}>
              {[
                { label: 'Max affected services', value: String(contract.approval.blastRadius.maxAffectedServices) },
                { label: 'Environments', value: contract.approval.blastRadius.environments.join(', ') },
                { label: 'Require reversible', value: contract.approval.blastRadius.requireReversible ? 'Yes' : 'No' },
              ].map(row => (
                <Stack key={row.label} direction="row" gap={2}>
                  <Typography variant="caption" color="text.disabled" sx={{ minWidth: 160 }}>{row.label}</Typography>
                  <Typography variant="caption" sx={{ fontWeight: 600 }}>{row.value}</Typography>
                </Stack>
              ))}
            </Stack>
          </Box>

          <Box>
            <SectionHeading
              title="Verification checks"
              help="Post-action health checks that must pass inside the verification window. Failed verification triggers rollback when configured."
            />
            <Stack gap={0.5} sx={{ mt: 0.75 }}>
              {contract.verify.checks.map((c, i) => (
                <Stack key={i} direction="row" gap={1.5} alignItems="center">
                  <Box sx={{ width: 4, height: 4, borderRadius: '50%', bgcolor: PRIMARY, flexShrink: 0 }} />
                  <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                    {c.metric} {c.condition}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </Box>

          <Box>
            <SectionHeading
              title="On resolve"
              help="Follow-up work Maximal prepares after recovery, so the incident can teach the next response without slowing down the current one."
            />
            <Stack direction="row" gap={1.5} sx={{ mt: 0.75 }} flexWrap="wrap">
              {contract.onResolve.draftPostmortem && <Chip label="Draft postmortem" size="small" sx={{ bgcolor: 'rgba(114,227,163,0.07)', color: PRIMARY, border: '1px solid rgba(114,227,163,0.18)', fontSize: '0.68rem' }} />}
              {contract.onResolve.learnContract && <Chip label="Learn contract" size="small" sx={{ bgcolor: 'rgba(77,182,245,0.07)', color: '#4db6f5', border: '1px solid rgba(77,182,245,0.18)', fontSize: '0.68rem' }} />}
            </Stack>
          </Box>

          <Box sx={{ p: 1.5, bgcolor: 'rgba(0,0,0,0.2)', borderRadius: 2, border: '1px solid rgba(114,227,163,0.08)' }}>
            <Stack direction="row" gap={1} alignItems="center">
              <InfoOutlinedIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
              <Typography variant="caption" color="text.disabled">
                Notify: {contract.notify.slackChannel} · Auto-rollback on failed verify: {contract.rollbackIfFailed ? 'yes' : 'no'}
              </Typography>
            </Stack>
          </Box>
        </Stack>
      </DialogContent>
    </Dialog>
  )
}

export default function ContractsPage() {
  const [contracts, setContracts] = useState<Contract[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Contract | null>(null)

  useEffect(() => {
    api.contracts.list().then(setContracts).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const filtered = contracts.filter(c =>
    search === '' || c.incidentType.toLowerCase().includes(search.toLowerCase())
  )

  const groups = Array.from(new Set(filtered.map(c => TYPE_GROUPS[c.incidentType] ?? 'Other'))).sort()

  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} gap={2} sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700, letterSpacing: '-0.02em' }}>Contracts</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {contracts.length} playbooks loaded · click any card to inspect
          </Typography>
        </Box>
        <Tooltip title="Contracts are YAML files loaded from the contracts/ directory at startup. Invalid contracts prevent boot.">
          <Stack direction="row" alignItems="center" gap={0.75}
            sx={{ bgcolor: 'rgba(114,227,163,0.08)', border: '1px solid rgba(114,227,163,0.18)', borderRadius: 5, px: 1.5, py: 0.6, cursor: 'default' }}>
            <CheckCircleIcon sx={{ fontSize: 14, color: PRIMARY }} />
            <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: PRIMARY }}>All contracts valid</Typography>
          </Stack>
        </Tooltip>
      </Stack>

      <TextField
        size="small"
        placeholder="Search by incident type…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        sx={{ mb: 3, maxWidth: 340 }}
        slotProps={{
          input: {
            startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18, color: 'text.disabled' }} /></InputAdornment>,
          }
        }}
      />

      {loading ? (
        <Grid container spacing={2.5}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Grid key={i} size={{ xs: 12, sm: 6, md: 4, lg: 3 }}>
              <Skeleton variant="rectangular" height={180} sx={{ borderRadius: 2 }} />
            </Grid>
          ))}
        </Grid>
      ) : (
        <Stack gap={4}>
          {groups.map(group => (
            <Box key={group}>
              <Typography variant="overline" sx={{ color: 'text.disabled', fontSize: '0.68rem', mb: 1.5, display: 'block' }}>
                {group} ({filtered.filter(c => (TYPE_GROUPS[c.incidentType] ?? 'Other') === group).length})
              </Typography>
              <Grid container spacing={2}>
                {filtered
                  .filter(c => (TYPE_GROUPS[c.incidentType] ?? 'Other') === group)
                  .map(c => (
                    <Grid key={c.incidentType} size={{ xs: 12, sm: 6, md: 4, lg: 3 }}>
                      <ContractCard contract={c} onClick={() => setSelected(c)} />
                    </Grid>
                  ))}
              </Grid>
            </Box>
          ))}
          {filtered.length === 0 && (
            <Typography color="text.secondary" variant="body2">No contracts match your search.</Typography>
          )}
        </Stack>
      )}

      {selected && <ContractDetail contract={selected} onClose={() => setSelected(null)} />}
    </Box>
  )
}
