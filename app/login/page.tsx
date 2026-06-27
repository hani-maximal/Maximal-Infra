'use client'
import React, { Suspense, useState } from 'react'
import NextLink from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import Alert from '@mui/material/Alert'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import { api } from '@/lib/api'

const PRIMARY = '#72e3a3'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const from = params.get('from') ?? '/app/incidents'

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const { token } = await api.auth.login(username, password)
      localStorage.setItem('maximal_token', token)
      document.cookie = `maximal_token=${token}; path=/; SameSite=Strict; max-age=86400`
      router.push(from)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid credentials')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: '#09100f',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
        position: 'relative',
        '&::before': {
          content: '""',
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse 60% 50% at 50% 0%, rgba(114,227,163,0.10), transparent 65%)',
          pointerEvents: 'none',
        },
      }}
    >
      <Box sx={{ width: '100%', maxWidth: 400 }}>
        {/* Logo */}
        <Box sx={{ textAlign: 'center', mb: 5 }}>
          <Typography
            component={NextLink}
            href="/"
            sx={{
              fontWeight: 800, fontSize: '1.35rem', letterSpacing: '-0.035em',
              color: PRIMARY, display: 'inline-block',
            }}
          >
            maximal
          </Typography>
        </Box>

        {/* Card */}
        <Box
          sx={{
            bgcolor: '#111a17',
            border: '1px solid rgba(114,227,163,0.12)',
            borderRadius: 3,
            p: { xs: 3, sm: 4 },
          }}
        >
          <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.75, letterSpacing: '-0.02em' }}>
            Sign in to Maximal
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3.5 }}>
            Enter your credentials to access the control plane.
          </Typography>

          {error && (
            <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>
          )}

          <Box component="form" onSubmit={handleSubmit}>
            <Stack gap={2.5}>
              <TextField
                label="Username"
                autoComplete="username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
                fullWidth
                autoFocus
                size="medium"
              />
              <TextField
                label="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                fullWidth
                size="medium"
              />
              <Button
                type="submit"
                variant="contained"
                fullWidth
                size="large"
                disabled={loading || !username || !password}
                sx={{ mt: 0.5, py: 1.25, fontSize: '0.95rem' }}
              >
                {loading ? <CircularProgress size={20} sx={{ color: '#09100f' }} /> : 'Sign in'}
              </Button>
            </Stack>
          </Box>

          <Divider sx={{ my: 3 }}>
            <Typography variant="caption" color="text.disabled">or</Typography>
          </Divider>

          <Stack gap={1.5}>
            <Button variant="outlined" fullWidth disabled sx={{ justifyContent: 'flex-start', gap: 1.5, color: 'text.secondary' }}>
              <Box component="span" sx={{ fontSize: '1rem' }}>G</Box>
              Continue with Google SSO
              <Box component="span" sx={{ ml: 'auto', fontSize: '0.65rem', opacity: 0.5 }}>Enterprise</Box>
            </Button>
            <Button variant="outlined" fullWidth disabled sx={{ justifyContent: 'flex-start', gap: 1.5, color: 'text.secondary' }}>
              <Box component="span" sx={{ fontSize: '1rem' }}>⬡</Box>
              Continue with SAML
              <Box component="span" sx={{ ml: 'auto', fontSize: '0.65rem', opacity: 0.5 }}>Enterprise</Box>
            </Button>
          </Stack>
        </Box>

        <Typography variant="body2" color="text.disabled" sx={{ textAlign: 'center', mt: 4 }}>
          Don&apos;t have an account?{' '}
          <Typography
            component="a"
            href="#"
            variant="body2"
            sx={{ color: PRIMARY, fontWeight: 600, cursor: 'pointer' }}
          >
            Request early access →
          </Typography>
        </Typography>
      </Box>
    </Box>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
