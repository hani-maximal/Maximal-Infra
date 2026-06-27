'use client'
import React, { useEffect, useState } from 'react'
import NextLink from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import Drawer from '@mui/material/Drawer'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Divider from '@mui/material/Divider'
import Avatar from '@mui/material/Avatar'
import Tooltip from '@mui/material/Tooltip'
import Badge from '@mui/material/Badge'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Breadcrumbs from '@mui/material/Breadcrumbs'
import DashboardIcon from '@mui/icons-material/Dashboard'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import DescriptionIcon from '@mui/icons-material/Description'
import LinkIcon from '@mui/icons-material/Link'
import TuneIcon from '@mui/icons-material/Tune'
import MenuIcon from '@mui/icons-material/Menu'
import LogoutIcon from '@mui/icons-material/Logout'
import NavigateNextIcon from '@mui/icons-material/NavigateNext'
import { api } from '@/lib/api'
import type { AuditRecord } from '@/lib/types'

const NAV_W = 240
const PRIMARY = '#72e3a3'

const NAV = [
  { label: 'Overview', href: '/app', icon: <DashboardIcon fontSize="small" />, exact: true },
  { label: 'Incidents', href: '/app/incidents', icon: <WarningAmberIcon fontSize="small" /> },
  { label: 'Contracts', href: '/app/contracts', icon: <DescriptionIcon fontSize="small" /> },
  { label: 'Connectors', href: '/app/connectors', icon: <LinkIcon fontSize="small" /> },
]

const BREADCRUMB_LABELS: Record<string, string> = {
  app: 'Home',
  incidents: 'Incidents',
  contracts: 'Contracts',
  connectors: 'Connectors',
  settings: 'Settings',
}

function payloadObject(record: AuditRecord): Record<string, unknown> {
  return record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {}
}

function countUnsafeWrites(records: AuditRecord[]) {
  let unsafeWrites = 0
  let lastPolicyDecision: string | null = null
  let hasPreActionSnapshot = false
  let hasApproval = false
  let lastAwsActionUnsafe = false

  for (const record of records) {
    const payload = payloadObject(record)

    if (record.eventType === 'policy_decision') {
      lastPolicyDecision = typeof payload.decision === 'string' ? payload.decision : null
    }

    if (record.eventType === 'snapshot') {
      hasPreActionSnapshot = true
    }

    if (record.eventType === 'approval_granted') {
      hasApproval = true
    }

    if (record.eventType === 'aws_action') {
      const policyAllowsWrite = lastPolicyDecision === 'AUTO' || lastPolicyDecision === 'APPROVE'
      const requiredApprovalPresent = lastPolicyDecision !== 'APPROVE' || hasApproval
      lastAwsActionUnsafe = !policyAllowsWrite || !hasPreActionSnapshot || !requiredApprovalPresent
      if (lastAwsActionUnsafe) unsafeWrites += 1
    }

    if (record.eventType === 'verification' && payload.ok === false && lastAwsActionUnsafe === false) {
      lastAwsActionUnsafe = true
      unsafeWrites += 1
    }

    if ((record.eventType === 'rollback' || record.eventType === 'escalation') && lastAwsActionUnsafe) {
      lastAwsActionUnsafe = false
      unsafeWrites = Math.max(0, unsafeWrites - 1)
    }
  }

  return unsafeWrites
}

function SafetyBadge() {
  const [unsafeWrites, setUnsafeWrites] = useState(0)

  useEffect(() => {
    let active = true

    async function loadUnsafeWrites() {
      try {
        const incidents = await api.incidents.list()
        const replays = await Promise.all(
          incidents.map(incident => api.incidents.replay(incident.id).catch(() => ({ valid: false, records: [] })))
        )
        if (!active) return
        setUnsafeWrites(replays.reduce((total, replay) => total + countUnsafeWrites(replay.records), 0))
      } catch {
        if (active) setUnsafeWrites(0)
      }
    }

    loadUnsafeWrites()
    const interval = window.setInterval(loadUnsafeWrites, 15000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [])

  const isSafe = unsafeWrites === 0
  const color = isSafe ? PRIMARY : '#f47272'
  const tooltip = isSafe
    ? 'No AWS write actions missing policy, approval, snapshot, verification, or rollback safeguards.'
    : `${unsafeWrites} AWS write action${unsafeWrites === 1 ? '' : 's'} missing required safeguards.`

  return (
    <Tooltip title={tooltip} placement="bottom">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75,
        bgcolor: isSafe ? 'rgba(114,227,163,0.08)' : 'rgba(244,114,114,0.10)',
        border: `1px solid ${isSafe ? 'rgba(114,227,163,0.18)' : 'rgba(244,114,114,0.25)'}`,
        borderRadius: 5, px: 1.25, py: 0.4 }}>
        <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: color }} />
        <Typography sx={{ fontSize: '0.72rem', fontWeight: 600, color }}>
          {unsafeWrites} unsafe writes
        </Typography>
      </Box>
    </Tooltip>
  )
}

function Breadcrumb() {
  const pathname = usePathname()
  const parts = pathname.split('/').filter(Boolean)
  return (
    <Breadcrumbs separator={<NavigateNextIcon fontSize="inherit" sx={{ fontSize: 14, color: 'text.disabled' }} />}>
      {parts.map((part, i) => {
        const isLast = i === parts.length - 1
        const label = BREADCRUMB_LABELS[part] ?? part
        return isLast ? (
          <Typography key={part} variant="body2" sx={{ fontWeight: 600, color: 'text.primary', fontSize: '0.85rem' }}>
            {label}
          </Typography>
        ) : (
          <Typography key={part} variant="body2" sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>
            {label}
          </Typography>
        )
      })}
    </Breadcrumbs>
  )
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const router = useRouter()
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)
  const [actionableCount, setActionableCount] = useState(0)

  useEffect(() => {
    let active = true
    let source: EventSource | null = null
    let pollInterval: number | null = null
    let errorCount = 0

    async function loadCount() {
      try {
        const incidents = await api.incidents.list()
        if (!active) return
        setActionableCount(
          incidents.filter(i => i.state === 'DETECTED' || i.state === 'AWAITING_APPROVAL').length
        )
      } catch {
        // non-fatal — badge stays at last known count
      }
    }

    function startPolling() {
      if (pollInterval) return
      loadCount()
      pollInterval = window.setInterval(loadCount, 15_000)
    }

    if (typeof EventSource !== 'undefined') {
      source = new EventSource('/api/incidents/stream')

      source.addEventListener('connected', () => {
        errorCount = 0
        loadCount()
      })

      source.addEventListener('incident_updated', () => {
        errorCount = 0
        loadCount()
      })

      source.onerror = () => {
        errorCount++
        // Fall back to polling after 3 consecutive failures; SSE auto-reconnects
        // so transient blips won't unnecessarily switch modes.
        if (errorCount >= 3 && active) {
          source?.close()
          source = null
          startPolling()
        }
      }
    } else {
      startPolling()
    }

    return () => {
      active = false
      source?.close()
      if (pollInterval) window.clearInterval(pollInterval)
    }
  }, [])

  function isActive(href: string, exact = false) {
    return exact ? pathname === href : pathname.startsWith(href)
  }

  function handleLogout() {
    localStorage.removeItem('maximal_token')
    document.cookie = 'maximal_token=; path=/; max-age=0'
    router.push('/login')
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Logo */}
      <Box
        component={NextLink}
        href="/app"
        sx={{ px: 2.5, py: 2.25, display: 'flex', alignItems: 'center', gap: 1.5, textDecoration: 'none' }}
      >
        <Box sx={{
          width: 30, height: 30, borderRadius: '8px',
          bgcolor: PRIMARY, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Typography sx={{ fontWeight: 900, fontSize: '13px', color: '#09100f', lineHeight: 1 }}>M</Typography>
        </Box>
        <Typography sx={{ fontWeight: 800, fontSize: '1rem', color: '#e8f5e9', letterSpacing: '-0.03em' }}>
          maximal
        </Typography>
      </Box>

      <Divider />

      {/* Org label */}
      <Box sx={{ px: 2.5, py: 1.5 }}>
        <Typography variant="caption" color="text.disabled" sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: '0.65rem', fontWeight: 600 }}>
          Workspace
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary', mt: 0.25 }}>
          Acme Corp
        </Typography>
      </Box>

      <Divider />

      {/* Nav */}
      <List sx={{ px: 1.5, pt: 1.5, flexGrow: 1 }}>
        {NAV.map(item => (
          <ListItem key={item.href} disablePadding sx={{ mb: 0.25 }}>
            <ListItemButton
              selected={isActive(item.href, item.exact)}
              onClick={() => { router.push(item.href); onNavigate?.() }}
              sx={{ py: 0.85, px: 1.25 }}
            >
              <ListItemIcon sx={{ minWidth: 34, color: isActive(item.href, item.exact) ? PRIMARY : 'rgba(232,245,233,0.45)' }}>
                {item.label === 'Incidents' ? (
                  <Badge badgeContent={actionableCount} color="error" invisible={actionableCount === 0} sx={{ '& .MuiBadge-badge': { fontSize: '0.6rem', minWidth: 14, height: 14, right: -2, top: 2 } }}>
                    {item.icon}
                  </Badge>
                ) : item.icon}
              </ListItemIcon>
              <ListItemText
                primary={item.label}
                primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: isActive(item.href, item.exact) ? 600 : 500 }}
              />
            </ListItemButton>
          </ListItem>
        ))}

        <Divider sx={{ my: 1.5 }} />

        <ListItem disablePadding sx={{ mb: 0.25 }}>
          <ListItemButton
            selected={isActive('/app/settings')}
            onClick={() => { router.push('/app/settings'); onNavigate?.() }}
            sx={{ py: 0.85, px: 1.25 }}
          >
            <ListItemIcon sx={{ minWidth: 34, color: isActive('/app/settings') ? PRIMARY : 'rgba(232,245,233,0.45)' }}>
              <TuneIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Settings" primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: isActive('/app/settings') ? 600 : 500 }} />
          </ListItemButton>
        </ListItem>
      </List>

      {/* User */}
      <Box sx={{ p: 1.5, borderTop: '1px solid rgba(114,227,163,0.10)' }}>
        <Stack
          direction="row" alignItems="center" gap={1.5}
          sx={{ p: 1, borderRadius: 2, cursor: 'pointer', '&:hover': { bgcolor: 'rgba(114,227,163,0.06)' } }}
          onClick={e => setAnchorEl(e.currentTarget)}
        >
          <Avatar sx={{ width: 30, height: 30, bgcolor: PRIMARY, color: '#09100f', fontSize: '0.8rem', fontWeight: 800 }}>A</Avatar>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, fontSize: '0.8rem', lineHeight: 1.2 }}>Admin</Typography>
            <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.7rem' }} noWrap>admin@acmecorp.com</Typography>
          </Box>
        </Stack>

        <Menu
          anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}
          PaperProps={{ sx: { minWidth: 180 } }}
          transformOrigin={{ horizontal: 'left', vertical: 'bottom' }}
          anchorOrigin={{ horizontal: 'left', vertical: 'top' }}
        >
          <MenuItem onClick={handleLogout} sx={{ gap: 1.5, color: 'error.main', fontSize: '0.875rem' }}>
            <LogoutIcon fontSize="small" /> Sign out
          </MenuItem>
        </Menu>
      </Box>
    </Box>
  )
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      {/* Desktop sidebar */}
      <Box
        component="aside"
        sx={{
          width: NAV_W, flexShrink: 0,
          display: { xs: 'none', md: 'block' },
        }}
      >
        <Box sx={{
          width: NAV_W, height: '100vh',
          position: 'fixed', top: 0, left: 0,
          bgcolor: 'background.paper',
          borderRight: '1px solid rgba(114,227,163,0.10)',
          overflowY: 'auto',
        }}>
          <SidebarContent />
        </Box>
      </Box>

      {/* Mobile drawer */}
      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        ModalProps={{ keepMounted: true }}
        PaperProps={{ sx: { width: NAV_W, bgcolor: 'background.paper' } }}
        sx={{ display: { md: 'none' } }}
      >
        <SidebarContent onNavigate={() => setMobileOpen(false)} />
      </Drawer>

      {/* Main */}
      <Box component="main" sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Top bar */}
        <Box sx={{
          height: 52, display: 'flex', alignItems: 'center', px: 3, gap: 2,
          borderBottom: '1px solid rgba(114,227,163,0.08)',
          position: 'sticky', top: 0, zIndex: 10,
          bgcolor: 'background.default',
        }}>
          <IconButton
            size="small"
            sx={{ display: { md: 'none' }, color: 'text.secondary' }}
            onClick={() => setMobileOpen(true)}
          >
            <MenuIcon fontSize="small" />
          </IconButton>
          <Breadcrumb />
          <Box sx={{ flexGrow: 1 }} />
          <SafetyBadge />
        </Box>

        {/* Content */}
        <Box sx={{ flexGrow: 1, p: { xs: 2, sm: 3 } }}>
          {children}
        </Box>
      </Box>
    </Box>
  )
}
