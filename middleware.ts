import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const authEnabled = Boolean(process.env.MAXIMAL_JWT_SECRET)
  const token = request.cookies.get('maximal_token')?.value
  const { pathname } = request.nextUrl

  if (authEnabled && pathname.startsWith('/app') && !token) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    if (pathname !== '/app') url.searchParams.set('from', pathname)
    return NextResponse.redirect(url)
  }

  if (pathname === '/login' && (!authEnabled || token)) {
    return NextResponse.redirect(new URL('/app/incidents', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/app/:path*', '/login'],
}
