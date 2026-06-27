'use client'
import { createTheme } from '@mui/material/styles'

const BG = '#09100f'
const SURFACE = '#111a17'
const PRIMARY = '#72e3a3'

export const theme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: BG, paper: SURFACE },
    primary: { main: PRIMARY, dark: '#4db87a', light: '#9eedc0', contrastText: '#09100f' },
    secondary: { main: '#4db6f5', contrastText: '#09100f' },
    error: { main: '#f47272' },
    warning: { main: '#f4b72f' },
    success: { main: PRIMARY },
    info: { main: '#4db6f5' },
    text: {
      primary: '#e8f5e9',
      secondary: 'rgba(232,245,233,0.55)',
      disabled: 'rgba(232,245,233,0.28)',
    },
    divider: 'rgba(114,227,163,0.12)',
    action: {
      hover: 'rgba(114,227,163,0.07)',
      selected: 'rgba(114,227,163,0.13)',
      focus: 'rgba(114,227,163,0.09)',
    },
  },
  typography: {
    fontFamily: '"Inter", system-ui, -apple-system, sans-serif',
    h1: { fontWeight: 700, letterSpacing: '-0.03em' },
    h2: { fontWeight: 700, letterSpacing: '-0.025em' },
    h3: { fontWeight: 600, letterSpacing: '-0.02em' },
    h4: { fontWeight: 600, letterSpacing: '-0.015em' },
    h5: { fontWeight: 600, letterSpacing: '-0.01em' },
    h6: { fontWeight: 600 },
    subtitle1: { fontWeight: 500 },
    subtitle2: { fontWeight: 500 },
    button: { fontWeight: 600, textTransform: 'none' as const, letterSpacing: '-0.01em' },
    overline: { letterSpacing: '0.1em', fontWeight: 600 },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        '*, *::before, *::after': { boxSizing: 'border-box' },
        body: {
          margin: 0,
          scrollbarColor: '#2d4a3a #09100f',
          '&::-webkit-scrollbar': { width: '6px', height: '6px' },
          '&::-webkit-scrollbar-track': { background: '#09100f' },
          '&::-webkit-scrollbar-thumb': { background: '#2d4a3a', borderRadius: '3px' },
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: { borderRadius: 8, padding: '7px 18px' },
        containedPrimary: {
          boxShadow: 'none',
          '&:hover': {
            boxShadow: '0 0 0 3px rgba(114,227,163,0.28)',
            backgroundColor: '#86e9b0',
          },
        },
        outlined: {
          borderColor: 'rgba(114,227,163,0.28)',
          '&:hover': {
            borderColor: 'rgba(114,227,163,0.55)',
            backgroundColor: 'rgba(114,227,163,0.06)',
          },
        },
        text: {
          '&:hover': { backgroundColor: 'rgba(114,227,163,0.07)' },
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: SURFACE,
          border: '1px solid rgba(114,227,163,0.10)',
        },
      },
    },
    MuiPaper: {
      styleOverrides: { root: { backgroundImage: 'none' } },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.01em' },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: { borderColor: 'rgba(114,227,163,0.08)', padding: '10px 16px' },
        head: {
          fontWeight: 600,
          fontSize: '0.72rem',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'rgba(232,245,233,0.50)',
          backgroundColor: 'rgba(0,0,0,0.15)',
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(114,227,163,0.20)' },
          '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(114,227,163,0.40)' },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: PRIMARY },
        },
      },
    },
    MuiDivider: {
      styleOverrides: { root: { borderColor: 'rgba(114,227,163,0.10)' } },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          margin: '1px 0',
          '&.Mui-selected': {
            backgroundColor: 'rgba(114,227,163,0.13)',
            color: PRIMARY,
            '&:hover': { backgroundColor: 'rgba(114,227,163,0.17)' },
            '& .MuiListItemIcon-root': { color: PRIMARY },
          },
          '&:hover': { backgroundColor: 'rgba(114,227,163,0.07)' },
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: '#1a2b22',
          border: '1px solid rgba(114,227,163,0.15)',
          fontSize: '0.75rem',
          fontWeight: 500,
        },
        arrow: { color: '#1a2b22' },
      },
    },
    MuiAlert: {
      styleOverrides: { root: { borderRadius: 8 } },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { borderRadius: 4, backgroundColor: 'rgba(114,227,163,0.1)' },
        bar: { borderRadius: 4 },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundColor: '#131f1a',
          border: '1px solid rgba(114,227,163,0.15)',
          borderRadius: 14,
        },
      },
    },
    MuiStepper: {
      styleOverrides: { root: {} },
    },
    MuiStepIcon: {
      styleOverrides: {
        root: {
          color: 'rgba(114,227,163,0.2)',
          '&.Mui-active': { color: PRIMARY },
          '&.Mui-completed': { color: PRIMARY },
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
          fontSize: '0.875rem',
        },
      },
    },
    MuiAccordion: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: 'transparent',
          border: '1px solid rgba(114,227,163,0.10)',
          borderRadius: '10px !important',
          '&:before': { display: 'none' },
          '&.Mui-expanded': { margin: 0 },
        },
      },
    },
  },
})
