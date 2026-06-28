import type { NextConfig } from 'next'

const ENGINE_URL = process.env.API_URL ?? 'http://localhost:4310'

const config: NextConfig = {
  output: 'standalone',
  async rewrites() {
    return {
      afterFiles: [
        { source: '/api/health', destination: `${ENGINE_URL}/api/health` },
        { source: '/api/incidents', destination: `${ENGINE_URL}/api/incidents` },
        { source: '/api/incidents/:path*', destination: `${ENGINE_URL}/api/incidents/:path*` },
        { source: '/api/contracts', destination: `${ENGINE_URL}/api/contracts` },
        { source: '/api/subscription', destination: `${ENGINE_URL}/api/subscription` },
        { source: '/api/trust-configs', destination: `${ENGINE_URL}/api/trust-configs` },
        { source: '/api/trust-configs/:path*', destination: `${ENGINE_URL}/api/trust-configs/:path*` },
        { source: '/api/auth/:path*', destination: `${ENGINE_URL}/api/auth/:path*` },
        { source: '/api/connectors', destination: `${ENGINE_URL}/api/connectors` },
        { source: '/api/connectors/:path*', destination: `${ENGINE_URL}/api/connectors/:path*` },
        { source: '/api/learning/:path*', destination: `${ENGINE_URL}/api/learning/:path*` },
      ],
    }
  },
}

export default config
