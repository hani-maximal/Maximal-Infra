'use client'
import React, { useEffect, useState } from 'react'
import NextLink from 'next/link'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import TextField from '@mui/material/TextField'
import Stepper from '@mui/material/Stepper'
import Step from '@mui/material/Step'
import StepLabel from '@mui/material/StepLabel'
import StepContent from '@mui/material/StepContent'
import Collapse from '@mui/material/Collapse'
import Alert from '@mui/material/Alert'
import Divider from '@mui/material/Divider'
import Grid from '@mui/material/Grid'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import DownloadIcon from '@mui/icons-material/Download'
import LockOutlinedIcon from '@mui/icons-material/LockOutlined'
import { api } from '@/lib/api'
import type { SubscriptionInfo } from '@/lib/types'

const PRIMARY = '#72e3a3'

type ConnectorState = 'not_connected' | 'partial' | 'connected'

interface ConnectorDef {
  id: string
  name: string
  category: string
  description: string
  state: ConnectorState
  optional?: boolean
  requiredTier: 'starter' | 'team' | 'scale' | 'enterprise'
}

const WEBHOOK_URL = 'https://app.maximal.io/webhooks/{your-tenant-id}'

const CONNECTORS: ConnectorDef[] = [
  { id: 'aws',       name: 'Amazon Web Services', category: 'Cloud',          requiredTier: 'starter', description: 'Connect your AWS account via a cross-account IAM role. Maximal reads CloudWatch, CloudTrail, ECS, Lambda, and ALB metrics — and executes remediation via scoped write roles.', state: 'not_connected' },
  { id: 'slack',     name: 'Slack',               category: 'Notifications',  requiredTier: 'team',    description: 'Receive incident evidence, confidence scores, and Approve / Deny buttons directly in Slack. Required for Level 1 (human approval) autonomy.', state: 'not_connected' },
  { id: 'github',    name: 'GitHub',              category: 'Source & Deploys', requiredTier: 'team',  description: 'Correlate incidents with recent deployments, trigger workflow re-runs, and open fix-as-code PRs automatically when Maximal resolves an incident.', state: 'not_connected' },
  { id: 'pagerduty', name: 'PagerDuty',           category: 'Alerting',       requiredTier: 'team',    description: 'Receive PagerDuty incidents as Maximal incidents via webhook. Maximal classifies them, matches a contract, and responds — or escalates back.', state: 'not_connected', optional: true },
  { id: 'datadog',   name: 'Datadog',             category: 'Observability',  requiredTier: 'scale',   description: 'Ingest Datadog RCA and monitor output via MCP. Maximal re-scores confidence against its own evidence before acting.', state: 'not_connected', optional: true },
]

const TIER_ORDER = ['starter', 'team', 'scale', 'enterprise']
function tierAtLeast(current: string, required: string) {
  return TIER_ORDER.indexOf(current) >= TIER_ORDER.indexOf(required)
}

const TIER_LABEL: Record<string, string> = {
  starter: 'Starter', team: 'Team', scale: 'Scale', enterprise: 'Enterprise',
}

function StatusBadge({ state }: { state: ConnectorState }) {
  const map = {
    connected:     { label: 'Connected',     color: PRIMARY,    bgcolor: 'rgba(114,227,163,0.10)', border: 'rgba(114,227,163,0.28)' },
    partial:       { label: 'Partial',       color: '#f4b72f',  bgcolor: 'rgba(244,183,47,0.10)',  border: 'rgba(244,183,47,0.28)' },
    not_connected: { label: 'Not connected', color: 'rgba(232,245,233,0.35)', bgcolor: 'rgba(232,245,233,0.05)', border: 'rgba(232,245,233,0.12)' },
  }[state]
  return (
    <Chip label={map.label} size="small"
      sx={{ bgcolor: map.bgcolor, color: map.color, border: `1px solid ${map.border}`, fontWeight: 700, fontSize: '0.68rem' }} />
  )
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Box>
      <Typography variant="caption" color="text.disabled" sx={{ mb: 0.5, display: 'block' }}>{label}</Typography>
      <Stack direction="row" alignItems="center" gap={1}
        sx={{ bgcolor: 'rgba(0,0,0,0.3)', borderRadius: 2, border: '1px solid rgba(114,227,163,0.12)', px: 1.5, py: 0.75 }}>
        <Typography sx={{ fontFamily: 'monospace', fontSize: '0.8rem', color: PRIMARY, flexGrow: 1, wordBreak: 'break-all' }}>{value}</Typography>
        <Tooltip title={copied ? 'Copied!' : 'Copy'}>
          <IconButton size="small" onClick={copy} sx={{ color: 'text.disabled', '&:hover': { color: PRIMARY } }}>
            {copied ? <CheckCircleIcon sx={{ fontSize: 16, color: PRIMARY }} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </Tooltip>
      </Stack>
    </Box>
  )
}

// ─── AWS Connector ──────────────────────────────────────────────────────────
function AwsSetup({ onConnect }: { onConnect: () => void }) {
  const [step, setStep] = useState(0)
  const [roleArn, setRoleArn] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'ok' | 'error' | null>(null)

  async function testConnection() {
    setTesting(true)
    setTestResult(null)
    await new Promise(r => setTimeout(r, 1500))
    setTestResult(roleArn.startsWith('arn:aws:iam::') ? 'ok' : 'error')
    setTesting(false)
    if (roleArn.startsWith('arn:aws:iam::')) { setTimeout(onConnect, 800) }
  }

  return (
    <Stepper activeStep={step} orientation="vertical">
      {[
        {
          label: 'Download the CloudFormation template',
          content: (
            <Stack gap={2}>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
                This template creates two IAM roles in your AWS account: a read role for observation, and per-service write roles that Maximal assumes via STS when executing remediations.
              </Typography>
              <Button variant="outlined" startIcon={<DownloadIcon />} href="#" size="small" sx={{ alignSelf: 'flex-start' }}>
                Download maximal-iam.yaml
              </Button>
              <Button variant="text" size="small" sx={{ alignSelf: 'flex-start', color: 'text.secondary' }} onClick={() => setStep(1)}>
                Already deployed → skip
              </Button>
            </Stack>
          ),
        },
        {
          label: 'Deploy to your AWS account',
          content: (
            <Stack gap={2}>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
                Run the template in your AWS console or via CLI. It needs CloudFormation permissions. The deployment takes about 60 seconds.
              </Typography>
              <Box sx={{ bgcolor: 'rgba(0,0,0,0.35)', borderRadius: 2, p: 2, border: '1px solid rgba(114,227,163,0.1)' }}>
                <Typography sx={{ fontFamily: 'monospace', fontSize: '0.78rem', color: 'rgba(232,245,233,0.75)', lineHeight: 1.8 }}>
                  {'aws cloudformation deploy \\\n  --template-file maximal-iam.yaml \\\n  --stack-name maximal-roles \\\n  --capabilities CAPABILITY_NAMED_IAM'}
                </Typography>
              </Box>
              <Button variant="outlined" size="small" endIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
                href="https://console.aws.amazon.com/cloudformation" target="_blank" sx={{ alignSelf: 'flex-start' }}>
                Open AWS CloudFormation
              </Button>
              <Button size="small" variant="contained" onClick={() => setStep(2)} sx={{ alignSelf: 'flex-start' }}>
                Done → next
              </Button>
            </Stack>
          ),
        },
        {
          label: 'Enter the IAM role ARN',
          content: (
            <Stack gap={2}>
              <Typography variant="body2" color="text.secondary">
                Copy the <code style={{ color: PRIMARY, fontSize: '0.8rem' }}>MaximalReadRoleArn</code> output from the CloudFormation stack.
              </Typography>
              <TextField
                label="Read role ARN"
                placeholder="arn:aws:iam::123456789012:role/MaximalReadRole"
                value={roleArn}
                onChange={e => setRoleArn(e.target.value)}
                size="small"
                fullWidth
                sx={{ maxWidth: 480 }}
              />
              <Button variant="contained" size="small" onClick={() => setStep(3)} disabled={!roleArn} sx={{ alignSelf: 'flex-start' }}>
                Next
              </Button>
            </Stack>
          ),
        },
        {
          label: 'Test connection',
          content: (
            <Stack gap={2}>
              <Typography variant="body2" color="text.secondary">
                Maximal will attempt to assume the role and run a test read (sts:GetCallerIdentity).
              </Typography>
              {testResult === 'ok' && <Alert severity="success">Connection successful. Maximal can now read your AWS account.</Alert>}
              {testResult === 'error' && <Alert severity="error">Could not assume role. Check the ARN and that the trust policy references Maximal&apos;s account.</Alert>}
              <Button variant="contained" size="small" onClick={testConnection} disabled={testing} sx={{ alignSelf: 'flex-start' }}>
                {testing ? 'Testing…' : 'Test connection'}
              </Button>
            </Stack>
          ),
        },
      ].map((s, i) => (
        <Step key={s.label} onClick={() => i < step && setStep(i)} sx={{ cursor: i < step ? 'pointer' : 'default' }}>
          <StepLabel><Typography variant="body2" sx={{ fontWeight: 600 }}>{s.label}</Typography></StepLabel>
          <StepContent>{s.content}</StepContent>
        </Step>
      ))}
    </Stepper>
  )
}

// ─── Slack Connector ────────────────────────────────────────────────────────
function SlackSetup({ onConnect }: { onConnect: () => void }) {
  return (
    <Stack gap={2.5}>
      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
        Maximal has a Slack App in the Slack marketplace. Click below to install it into your workspace. You&apos;ll be asked to grant <code style={{ color: PRIMARY, fontSize: '0.8rem' }}>chat:write</code> and <code style={{ color: PRIMARY, fontSize: '0.8rem' }}>channels:read</code> scopes.
      </Typography>
      <Button
        variant="contained"
        href="#"
        startIcon={<Box component="span" sx={{ fontWeight: 800, fontSize: '1rem', lineHeight: 1 }}>#</Box>}
        onClick={e => { e.preventDefault(); onConnect() }}
        sx={{ alignSelf: 'flex-start' }}
      >
        Add to Slack
      </Button>
      <Alert severity="info" sx={{ maxWidth: 480 }}>
        After installing, invite the Maximal bot to the channel(s) you specify in each contract&apos;s <code>notify.slack_channel</code>.
      </Alert>
    </Stack>
  )
}

// ─── GitHub Connector ────────────────────────────────────────────────────────
function GitHubSetup({ onConnect }: { onConnect: () => void }) {
  return (
    <Stack gap={2.5}>
      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
        Install the Maximal GitHub App to your organisation. This grants read access for deploy correlation, <code style={{ color: PRIMARY, fontSize: '0.8rem' }}>actions:write</code> for workflow re-runs, and <code style={{ color: PRIMARY, fontSize: '0.8rem' }}>contents:write</code> for fix-as-code PRs.
      </Typography>
      <Button variant="contained" href="#" endIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
        onClick={e => { e.preventDefault(); onConnect() }}
        sx={{ alignSelf: 'flex-start' }}>
        Install GitHub App
      </Button>
      <Typography variant="caption" color="text.secondary">
        You can select individual repositories during installation. Maximal only reads repos you explicitly grant access to.
      </Typography>
    </Stack>
  )
}

// ─── PagerDuty / Datadog Connector ─────────────────────────────────────────
function WebhookSetup({ name, onConnect }: { name: string; onConnect: () => void }) {
  const webhookUrl = `https://app.maximal.io/webhooks/tenant_xxx/${name.toLowerCase()}`
  return (
    <Stack gap={2.5}>
      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
        Configure a webhook in your {name} account to send events to Maximal. No API key required on Maximal&apos;s side — events are verified by HMAC signature.
      </Typography>
      <CopyField label="Webhook URL" value={webhookUrl} />
      <Alert severity="info" sx={{ maxWidth: 480 }}>
        In {name}, go to <strong>Integrations → Webhooks → Add Webhook</strong>, paste the URL above, and set the signing secret below.
      </Alert>
      <TextField label="Signing secret (from your Maximal workspace)" size="small" disabled value="••••••••••••••••••••••••" sx={{ maxWidth: 360 }} />
      <Button variant="outlined" size="small" onClick={onConnect} sx={{ alignSelf: 'flex-start' }}>
        Mark as configured
      </Button>
    </Stack>
  )
}

// ─── Connector Card ─────────────────────────────────────────────────────────
function ConnectorCard({ def, locked }: { def: ConnectorDef; locked: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [state, setState] = useState<ConnectorState>(def.state)

  return (
    <Card sx={{
      transition: 'border-color 0.18s, opacity 0.18s',
      ...(state === 'connected' && { borderColor: 'rgba(114,227,163,0.28)' }),
      ...(locked && { opacity: 0.6 }),
    }}>
      <CardContent sx={{ p: 2.5 }}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={1}>
          <Box>
            <Stack direction="row" alignItems="center" gap={1} sx={{ mb: 0.75 }}>
              <Typography variant="body1" sx={{ fontWeight: 700, fontSize: '0.9rem' }}>{def.name}</Typography>
              {def.optional && !locked && (
                <Chip label="Optional" size="small" sx={{ bgcolor: 'rgba(232,245,233,0.05)', color: 'text.disabled', border: '1px solid rgba(232,245,233,0.1)', fontSize: '0.62rem' }} />
              )}
              {locked && (
                <Chip
                  label={`${TIER_LABEL[def.requiredTier] ?? def.requiredTier}+`}
                  size="small"
                  icon={<LockOutlinedIcon style={{ fontSize: 11 }} />}
                  sx={{ bgcolor: 'rgba(232,245,233,0.05)', color: 'text.disabled', border: '1px solid rgba(232,245,233,0.12)', fontSize: '0.62rem' }}
                />
              )}
            </Stack>
            <Typography variant="caption" sx={{ color: 'rgba(114,227,163,0.55)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.62rem' }}>
              {def.category}
            </Typography>
          </Box>
          <Stack direction="row" alignItems="center" gap={1}>
            {locked ? (
              <LockOutlinedIcon sx={{ fontSize: 18, color: 'text.disabled' }} />
            ) : (
              <>
                <StatusBadge state={state} />
                {state !== 'connected' && (
                  <IconButton size="small" onClick={() => setExpanded(v => !v)}>
                    {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                  </IconButton>
                )}
                {state === 'connected' && <CheckCircleIcon sx={{ fontSize: 18, color: PRIMARY }} />}
              </>
            )}
          </Stack>
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, mb: expanded ? 2.5 : 0, lineHeight: 1.7, fontSize: '0.83rem' }}>
          {def.description}
        </Typography>

        {locked && (
          <Button
            component={NextLink}
            href="/app/settings?tab=plan"
            size="small"
            variant="outlined"
            startIcon={<LockOutlinedIcon sx={{ fontSize: 14 }} />}
            sx={{ mt: 2, color: 'text.secondary', borderColor: 'rgba(232,245,233,0.15)' }}
          >
            Upgrade to {TIER_LABEL[def.requiredTier]} to unlock
          </Button>
        )}

        {!locked && state !== 'connected' && !expanded && (
          <Button size="small" variant="outlined" onClick={() => setExpanded(true)} sx={{ mt: 2 }}>
            Set up connector
          </Button>
        )}

        {!locked && (
          <Collapse in={expanded}>
            <Divider sx={{ mb: 2.5 }} />
            {def.id === 'aws' && <AwsSetup onConnect={() => { setState('connected'); setExpanded(false) }} />}
            {def.id === 'slack' && <SlackSetup onConnect={() => { setState('connected'); setExpanded(false) }} />}
            {def.id === 'github' && <GitHubSetup onConnect={() => { setState('connected'); setExpanded(false) }} />}
            {(def.id === 'pagerduty' || def.id === 'datadog') && <WebhookSetup name={def.name} onConnect={() => { setState('connected'); setExpanded(false) }} />}
          </Collapse>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────
export default function ConnectorsPage() {
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null)

  useEffect(() => {
    api.subscription.get().then(setSubscription).catch(() => {})
  }, [])

  const allowedConnectors = subscription?.limits.allowedConnectors ?? null
  const connected = CONNECTORS.filter(c => c.state === 'connected').length
  const required = CONNECTORS.filter(c => !c.optional)

  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} gap={2} sx={{ mb: 1.5 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700, letterSpacing: '-0.02em' }}>Connectors</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Connect your stack to start monitoring and remediating.
          </Typography>
        </Box>
        <Chip
          label={`${connected} / ${CONNECTORS.length} connected`}
          sx={{
            bgcolor: connected === required.length ? 'rgba(114,227,163,0.10)' : 'rgba(244,183,47,0.10)',
            color: connected === required.length ? PRIMARY : '#f4b72f',
            border: `1px solid ${connected === required.length ? 'rgba(114,227,163,0.28)' : 'rgba(244,183,47,0.28)'}`,
            fontWeight: 700,
          }}
        />
      </Stack>

      {connected < required.length && (
        <Alert severity="warning" sx={{ mb: 3, maxWidth: 600 }}>
          AWS and Slack are required for full incident remediation. You can start in <strong>shadow mode</strong> (observe only) with just AWS.
        </Alert>
      )}

      <Stack gap={2}>
        {CONNECTORS.map(def => (
          <ConnectorCard
            key={def.id}
            def={def}
            locked={allowedConnectors !== null && !allowedConnectors.includes(def.id)}
          />
        ))}
      </Stack>
    </Box>
  )
}
