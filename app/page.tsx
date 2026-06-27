'use client'
import React, { useState, useEffect } from 'react'
import NextLink from 'next/link'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Container from '@mui/material/Container'
import Grid from '@mui/material/Grid'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import Drawer from '@mui/material/Drawer'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import SecurityIcon from '@mui/icons-material/Security'
import TrackChangesIcon from '@mui/icons-material/TrackChanges'
import HistoryIcon from '@mui/icons-material/History'
import RadarIcon from '@mui/icons-material/Radar'
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser'
import TuneIcon from '@mui/icons-material/Tune'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import MenuIcon from '@mui/icons-material/Menu'
import CloseIcon from '@mui/icons-material/Close'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import CheckIcon from '@mui/icons-material/Check'

const PRIMARY = '#72e3a3'
const BG = '#09100f'
const SURFACE = '#111a17'

// ─── Nav ───────────────────────────────────────────────────────────────────
function Nav({ scrolled }: { scrolled: boolean }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const navLinks = ['Product', 'Docs', 'Pricing', 'Blog']

  return (
    <>
      <Box
        component="nav"
        sx={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
          borderBottom: scrolled ? '1px solid rgba(114,227,163,0.12)' : '1px solid transparent',
          backdropFilter: scrolled ? 'blur(20px)' : 'none',
          bgcolor: scrolled ? 'rgba(9,16,15,0.85)' : 'transparent',
          transition: 'all 0.3s ease',
        }}
      >
        <Container maxWidth="lg">
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ height: 64 }}>
            <Typography sx={{ fontWeight: 800, fontSize: '1.15rem', letterSpacing: '-0.03em', color: PRIMARY }}>
              maximal
            </Typography>
            <Stack direction="row" gap={4} sx={{ display: { xs: 'none', md: 'flex' } }}>
              {navLinks.map(l => (
                <Typography
                  key={l}
                  component="a"
                  href="#"
                  sx={{ fontSize: '0.875rem', fontWeight: 500, color: 'rgba(232,245,233,0.65)', '&:hover': { color: '#e8f5e9' }, transition: 'color 0.2s', cursor: 'pointer' }}
                >
                  {l}
                </Typography>
              ))}
            </Stack>
            <Stack direction="row" gap={1.5} sx={{ display: { xs: 'none', md: 'flex' } }}>
              <Button component={NextLink} href="/login" variant="text" size="small" sx={{ color: 'rgba(232,245,233,0.7)' }}>
                Sign in
              </Button>
              <Button component={NextLink} href="/login" variant="contained" size="small">
                Request access
              </Button>
            </Stack>
            <IconButton sx={{ display: { md: 'none' }, color: 'text.primary' }} onClick={() => setMobileOpen(true)}>
              <MenuIcon />
            </IconButton>
          </Stack>
        </Container>
      </Box>

      <Drawer anchor="right" open={mobileOpen} onClose={() => setMobileOpen(false)}
        PaperProps={{ sx: { width: 280, bgcolor: '#0f1a14', borderLeft: '1px solid rgba(114,227,163,0.12)' } }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ p: 2 }}>
          <Typography sx={{ fontWeight: 800, color: PRIMARY }}>maximal</Typography>
          <IconButton onClick={() => setMobileOpen(false)} size="small"><CloseIcon /></IconButton>
        </Stack>
        <Divider />
        <List sx={{ px: 1, pt: 1 }}>
          {navLinks.map(l => (
            <ListItem key={l} disablePadding>
              <ListItemButton sx={{ borderRadius: 2 }}>
                <Typography sx={{ fontWeight: 500 }}>{l}</Typography>
              </ListItemButton>
            </ListItem>
          ))}
        </List>
        <Box sx={{ p: 2, mt: 'auto' }}>
          <Button component={NextLink} href="/login" variant="contained" fullWidth>Request access</Button>
        </Box>
      </Drawer>
    </>
  )
}

// ─── Hero ──────────────────────────────────────────────────────────────────
function Hero() {
  return (
    <Box
      sx={{
        pt: { xs: '110px', md: '140px' },
        pb: { xs: '80px', md: '110px' },
        textAlign: 'center',
        position: 'relative',
        overflow: 'hidden',
        '&::before': {
          content: '""',
          position: 'absolute', inset: 0,
          background: 'radial-gradient(ellipse 70% 55% at 50% -5%, rgba(114,227,163,0.15), transparent 70%)',
          pointerEvents: 'none',
        },
      }}
    >
      <Container maxWidth="md">
        <Chip
          label="Now in private beta — apply for early access →"
          size="small"
          sx={{
            mb: 3, bgcolor: 'rgba(114,227,163,0.1)', color: PRIMARY,
            border: '1px solid rgba(114,227,163,0.25)', fontWeight: 600,
            fontSize: '0.78rem', cursor: 'default',
          }}
        />

        <Typography
          variant="h1"
          sx={{
            fontSize: { xs: '2.5rem', sm: '3.25rem', md: '4.25rem' },
            fontWeight: 800,
            lineHeight: 1.08,
            letterSpacing: '-0.04em',
            mb: 3,
          }}
        >
          AWS incident response,{' '}
          <Box
            component="span"
            sx={{
              background: `linear-gradient(135deg, ${PRIMARY} 0%, #4db6f5 100%)`,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            done safely
          </Box>
        </Typography>

        <Typography
          variant="h5"
          sx={{
            color: 'text.secondary', fontWeight: 400,
            maxWidth: 580, mx: 'auto', lineHeight: 1.6,
            fontSize: { xs: '1rem', md: '1.15rem' },
            mb: 5,
          }}
        >
          The control plane that turns any incident diagnosis into a typed, bounded,
          verified, reversible AWS action — with a complete audit trail and zero unsafe writes.
        </Typography>

        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} justifyContent="center" alignItems="center">
          <Button
            component={NextLink} href="/login" variant="contained" size="large"
            endIcon={<ArrowForwardIcon />}
            sx={{ px: 4, py: 1.25, fontSize: '0.95rem', minWidth: 200 }}
          >
            Get early access
          </Button>
          <Button
            variant="outlined" size="large"
            href="#how-it-works"
            sx={{ px: 4, py: 1.25, fontSize: '0.95rem' }}
          >
            See how it works
          </Button>
        </Stack>

        {/* Stat bar */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          gap={{ xs: 3, sm: 5 }}
          justifyContent="center"
          divider={<Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' } }} />}
          sx={{ mt: 8, pt: 5, borderTop: '1px solid rgba(114,227,163,0.1)' }}
        >
          {[
            { value: '0', label: 'Unsafe writes in production' },
            { value: '< 60s', label: 'Median time to remediate' },
            { value: '23', label: 'Incident patterns covered' },
          ].map(s => (
            <Box key={s.label} sx={{ textAlign: 'center' }}>
              <Typography sx={{ fontSize: '2rem', fontWeight: 800, color: PRIMARY, letterSpacing: '-0.03em' }}>
                {s.value}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{s.label}</Typography>
            </Box>
          ))}
        </Stack>
      </Container>
    </Box>
  )
}

// ─── Features ──────────────────────────────────────────────────────────────
const FEATURES = [
  {
    icon: <SecurityIcon />,
    title: 'Typed actions only',
    body: 'No shell access, no eval, no arbitrary commands. Every AWS write is a named, code-defined function with Zod validation at the boundary.',
  },
  {
    icon: <RadarIcon />,
    title: 'Confidence gating',
    body: 'Actions execute only above your configured threshold — with 2+ corroborating evidence sources required. Below the gate, it escalates to a human.',
  },
  {
    icon: <HistoryIcon />,
    title: 'Snapshot & auto-revert',
    body: 'State is captured before every write. If the health check fails after execution, Maximal automatically reverts and pages your team.',
  },
  {
    icon: <TrackChangesIcon />,
    title: 'Blast radius limits',
    body: 'Per-service contracts define the maximum scope of any automated action — which services, which environments, which action types.',
  },
  {
    icon: <VerifiedUserIcon />,
    title: 'Append-only audit trail',
    body: 'SHA-256 hash-chained records for every signal, decision, AWS call, and approval. Replay any incident to the millisecond.',
  },
  {
    icon: <TuneIcon />,
    title: 'Three autonomy levels',
    body: 'Observe (read-only), Approve (human in the loop), or Bounded Auto (autonomous within limits). You set the level per service, per environment.',
  },
]

function FeatureCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <Card
      sx={{
        height: '100%', p: 0.5,
        transition: 'border-color 0.2s, box-shadow 0.2s',
        '&:hover': {
          borderColor: 'rgba(114,227,163,0.28)',
          boxShadow: '0 0 0 1px rgba(114,227,163,0.12)',
        },
      }}
    >
      <CardContent sx={{ p: 3 }}>
        <Box sx={{
          width: 40, height: 40, borderRadius: '10px',
          bgcolor: 'rgba(114,227,163,0.1)', color: PRIMARY,
          display: 'flex', alignItems: 'center', justifyContent: 'center', mb: 2,
        }}>
          {icon}
        </Box>
        <Typography variant="h6" sx={{ mb: 1, fontSize: '0.95rem', fontWeight: 700 }}>{title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>{body}</Typography>
      </CardContent>
    </Card>
  )
}

function Features() {
  return (
    <Box sx={{ py: { xs: 8, md: 12 } }}>
      <Container maxWidth="lg">
        <Box sx={{ textAlign: 'center', mb: 8 }}>
          <Typography variant="overline" sx={{ color: PRIMARY, mb: 1, display: 'block' }}>
            Built for safety
          </Typography>
          <Typography variant="h3" sx={{ fontSize: { xs: '1.75rem', md: '2.25rem' }, mb: 2 }}>
            Every guardrail, by default
          </Typography>
          <Typography color="text.secondary" sx={{ maxWidth: 520, mx: 'auto' }}>
            The product is the trusted action layer — not the diagnosis. We built every safety property in from day one.
          </Typography>
        </Box>
        <Grid container spacing={3}>
          {FEATURES.map(f => (
            <Grid key={f.title} size={{ xs: 12, sm: 6, md: 4 }}>
              <FeatureCard {...f} />
            </Grid>
          ))}
        </Grid>
      </Container>
    </Box>
  )
}

// ─── How it works ──────────────────────────────────────────────────────────
const STEPS = [
  {
    number: '01',
    title: 'Connect your AWS account',
    body: 'Run a single CloudFormation template in your account. It creates a scoped cross-account IAM role — one for reads, one per service for writes. No credentials leave your account.',
    badge: 'AWS',
  },
  {
    number: '02',
    title: 'Configure playbooks',
    body: 'Write YAML contracts that declare which services Maximal watches, what thresholds trigger action, what actions are allowed, and what the blast radius limit is.',
    badge: 'Playbooks',
  },
  {
    number: '03',
    title: 'Incidents flow in automatically',
    body: 'From CloudWatch alarms, PagerDuty webhooks, Datadog, or Maximal\'s own detectors. Maximal classifies, matches a contract, and evaluates the policy — in seconds.',
    badge: 'Detection',
  },
  {
    number: '04',
    title: 'Approve in Slack or watch it auto-remediate',
    body: 'At Level 1, you get a Slack message with evidence, confidence, and Approve / Deny. At Level 2, reversible in-contract actions execute automatically and verify themselves.',
    badge: 'Remediation',
  },
]

function HowItWorks() {
  return (
    <Box id="how-it-works" sx={{ py: { xs: 8, md: 12 }, bgcolor: 'rgba(0,0,0,0.2)' }}>
      <Container maxWidth="lg">
        <Box sx={{ textAlign: 'center', mb: 8 }}>
          <Typography variant="overline" sx={{ color: PRIMARY, mb: 1, display: 'block' }}>
            How it works
          </Typography>
          <Typography variant="h3" sx={{ fontSize: { xs: '1.75rem', md: '2.25rem' } }}>
            From diagnosis to resolved in four steps
          </Typography>
        </Box>

        <Stack gap={3}>
          {STEPS.map((step, i) => (
            <Box
              key={step.number}
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', md: i % 2 === 0 ? 'row' : 'row-reverse' },
                gap: 4, alignItems: 'center',
              }}
            >
              <Box sx={{ flex: 1 }}>
                <Stack direction="row" alignItems="center" gap={1.5} sx={{ mb: 1.5 }}>
                  <Typography sx={{ fontWeight: 800, fontSize: '0.75rem', color: PRIMARY, letterSpacing: '0.1em' }}>
                    {step.number}
                  </Typography>
                  <Chip label={step.badge} size="small"
                    sx={{ bgcolor: 'rgba(114,227,163,0.08)', color: PRIMARY, border: '1px solid rgba(114,227,163,0.2)', fontSize: '0.7rem' }} />
                </Stack>
                <Typography variant="h5" sx={{ mb: 1.5, fontWeight: 700 }}>{step.title}</Typography>
                <Typography color="text.secondary" sx={{ lineHeight: 1.7, maxWidth: 460 }}>{step.body}</Typography>
              </Box>
              <Card sx={{ flex: 1, maxWidth: { md: 440 }, minHeight: 160,
                background: 'linear-gradient(135deg, rgba(114,227,163,0.05) 0%, rgba(77,182,245,0.03) 100%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3 }}>
                <Typography sx={{ fontWeight: 800, fontSize: '4rem', color: 'rgba(114,227,163,0.12)', letterSpacing: '-0.04em' }}>
                  {step.number}
                </Typography>
              </Card>
            </Box>
          ))}
        </Stack>
      </Container>
    </Box>
  )
}

// ─── Integrations ──────────────────────────────────────────────────────────
const INTEGRATIONS = ['Amazon Web Services', 'Slack', 'GitHub', 'PagerDuty', 'Datadog', 'CloudWatch']

function Integrations() {
  return (
    <Box sx={{ py: { xs: 8, md: 10 } }}>
      <Container maxWidth="lg">
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ textAlign: 'center', mb: 4, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, fontSize: '0.72rem' }}
        >
          Connects to your stack
        </Typography>
        <Stack direction="row" flexWrap="wrap" gap={2} justifyContent="center">
          {INTEGRATIONS.map(name => (
            <Chip
              key={name} label={name}
              sx={{
                bgcolor: 'rgba(114,227,163,0.06)', color: 'rgba(232,245,233,0.7)',
                border: '1px solid rgba(114,227,163,0.12)', fontWeight: 500,
                fontSize: '0.8rem', px: 1, py: 2.5,
              }}
            />
          ))}
        </Stack>
      </Container>
    </Box>
  )
}

// ─── Pricing ───────────────────────────────────────────────────────────────
const PLANS = [
  {
    name: 'Starter',
    price: 'Free',
    sub: 'Shadow mode, up to 3 services',
    highlight: false,
    features: ['Shadow mode (Observe)', 'Up to 3 monitored services', '23 incident type patterns', 'Append-only audit log', 'Community support'],
    cta: 'Get started free',
  },
  {
    name: 'Team',
    price: '$399',
    sub: 'per month, billed annually or $499 month-to-month',
    highlight: true,
    features: ['Everything in Starter', 'Approve + Bounded Auto levels', 'Unlimited services', 'Slack approval workflows', 'GitHub & PagerDuty connectors', 'Audit log export', 'Priority support'],
    cta: 'Start free trial',
  },
  {
    name: 'Scale',
    price: '$999',
    sub: 'per month, billed annually',
    highlight: false,
    features: ['Everything in Team', 'Higher incident volume', 'Advanced approval policies', 'Custom trust levels', 'SLA reports', 'Premium support'],
    cta: 'Talk to sales',
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    sub: 'VPC deployment + enterprise controls',
    highlight: false,
    features: ['Everything in Scale', 'On-prem / VPC deployment', 'Custom playbooks & SLA', 'SSO (SAML / OIDC)', 'Dedicated success engineer', 'Custom contract authoring'],
    cta: 'Talk to sales',
  },
]

function Pricing() {
  return (
    <Box id="pricing" sx={{ py: { xs: 8, md: 12 }, bgcolor: 'rgba(0,0,0,0.18)' }}>
      <Container maxWidth="lg">
        <Box sx={{ textAlign: 'center', mb: 8 }}>
          <Typography variant="overline" sx={{ color: PRIMARY, mb: 1, display: 'block' }}>Pricing</Typography>
          <Typography variant="h3" sx={{ fontSize: { xs: '1.75rem', md: '2.25rem' }, mb: 2 }}>
            Start for free, scale with confidence
          </Typography>
          <Typography color="text.secondary">No credit card required to start. Cancel anytime.</Typography>
        </Box>

        <Grid container spacing={3} alignItems="stretch">
          {PLANS.map(plan => (
            <Grid key={plan.name} size={{ xs: 12, sm: 6, lg: 3 }}>
              <Card
                sx={{
                  height: '100%',
                  ...(plan.highlight && {
                    border: `1px solid rgba(114,227,163,0.40)`,
                    boxShadow: '0 0 40px rgba(114,227,163,0.08)',
                    position: 'relative',
                    overflow: 'visible',
                  }),
                }}
              >
                {plan.highlight && (
                  <Box sx={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)' }}>
                    <Chip label="Most popular" size="small"
                      sx={{ bgcolor: PRIMARY, color: '#09100f', fontWeight: 700, fontSize: '0.72rem' }} />
                  </Box>
                )}
                <CardContent sx={{ p: 3.5 }}>
                  <Typography variant="overline" sx={{ color: PRIMARY, fontSize: '0.72rem' }}>{plan.name}</Typography>
                  <Typography sx={{ fontSize: plan.price === 'Custom' ? '2.25rem' : '2.75rem', fontWeight: 800, letterSpacing: '-0.03em', my: 1 }}>
                    {plan.price}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>{plan.sub}</Typography>
                  <Button
                    component={NextLink} href="/login"
                    variant={plan.highlight ? 'contained' : 'outlined'}
                    fullWidth sx={{ mb: 3 }}
                  >
                    {plan.cta}
                  </Button>
                  <Divider sx={{ mb: 2.5 }} />
                  <Stack gap={1.5}>
                    {plan.features.map(f => (
                      <Stack key={f} direction="row" alignItems="flex-start" gap={1.5}>
                        <CheckIcon sx={{ fontSize: 16, color: PRIMARY, mt: 0.25, flexShrink: 0 }} />
                        <Typography variant="body2" color="text.secondary">{f}</Typography>
                      </Stack>
                    ))}
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Container>
    </Box>
  )
}

// ─── CTA ───────────────────────────────────────────────────────────────────
function Cta() {
  return (
    <Box sx={{ py: { xs: 8, md: 12 }, textAlign: 'center', position: 'relative', overflow: 'hidden',
      '&::before': {
        content: '""', position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse 60% 80% at 50% 50%, rgba(114,227,163,0.10), transparent 70%)',
      } }}>
      <Container maxWidth="sm">
        <CheckCircleIcon sx={{ fontSize: 48, color: PRIMARY, mb: 2 }} />
        <Typography variant="h3" sx={{ fontWeight: 800, fontSize: { xs: '1.75rem', md: '2.25rem' }, mb: 2 }}>
          Zero unsafe writes. Guaranteed.
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 4, lineHeight: 1.7 }}>
          Connect your first AWS account in under 10 minutes. Start in shadow mode — watch incidents flow through without touching anything — then enable autonomy one service at a time.
        </Typography>
        <Button component={NextLink} href="/login" variant="contained" size="large" endIcon={<ArrowForwardIcon />}
          sx={{ px: 5, py: 1.5, fontSize: '1rem' }}>
          Request early access
        </Button>
      </Container>
    </Box>
  )
}

// ─── Footer ────────────────────────────────────────────────────────────────
function Footer() {
  const cols = [
    { title: 'Product', links: ['Features', 'Pricing', 'Changelog', 'Roadmap'] },
    { title: 'Resources', links: ['Documentation', 'GitHub', 'Status', 'Security'] },
    { title: 'Company', links: ['About', 'Blog', 'Privacy', 'Terms'] },
  ]
  return (
    <Box sx={{ borderTop: '1px solid rgba(114,227,163,0.10)', py: 8 }}>
      <Container maxWidth="lg">
        <Grid container spacing={4}>
          <Grid size={{ xs: 12, md: 3 }}>
            <Typography sx={{ fontWeight: 800, fontSize: '1.15rem', color: PRIMARY, letterSpacing: '-0.03em', mb: 1.5 }}>
              maximal
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
              The safe execution control plane for AWS incident remediation.
            </Typography>
          </Grid>
          {cols.map(col => (
            <Grid key={col.title} size={{ xs: 6, sm: 4, md: 3 }}>
              <Typography variant="overline" sx={{ color: 'rgba(232,245,233,0.45)', fontSize: '0.7rem', mb: 2, display: 'block' }}>
                {col.title}
              </Typography>
              <Stack gap={1.5}>
                {col.links.map(l => (
                  <Typography key={l} component="a" href="#" variant="body2"
                    sx={{ color: 'text.secondary', '&:hover': { color: 'text.primary' }, transition: 'color 0.2s', cursor: 'pointer' }}>
                    {l}
                  </Typography>
                ))}
              </Stack>
            </Grid>
          ))}
        </Grid>
        <Divider sx={{ my: 6 }} />
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={2}>
          <Typography variant="body2" color="text.disabled">© 2026 Maximal. All rights reserved.</Typography>
          <Typography variant="body2" color="text.disabled">Built for platform engineers who care about safety.</Typography>
        </Stack>
      </Container>
    </Box>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────
export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <Box sx={{ bgcolor: BG, color: '#e8f5e9', minHeight: '100vh' }}>
      <Nav scrolled={scrolled} />
      <Hero />
      <Divider />
      <Features />
      <HowItWorks />
      <Integrations />
      <Pricing />
      <Cta />
      <Footer />
    </Box>
  )
}
