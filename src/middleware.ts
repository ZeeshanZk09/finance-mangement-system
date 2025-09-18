// src/middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { actorFromPayload, verifyJwt } from '@/lib/auth/jwt';
import { getTenantFromHost, getTenantFromPath } from '@/utils/helpers/tenantHelpers';
import { rateLimit } from '@/lib/security/rateLimit';
import { ApiError } from './utils/NextApiError';

export async function middleware(req: NextRequest) {
  const url = req.nextUrl;
  const res = NextResponse.next();

  // 1. Tenant Resolution
  let tenantId =
    (await getTenantFromHost(url.hostname)).id || (await getTenantFromPath(url.pathname)).id;
  if (!tenantId) {
    return NextResponse.json({ error: 'Tenant not resolved' }, { status: 400 });
  }
  res.headers.set('x-tenant-id', tenantId);

  // 2. Authentication
  const token =
    req.cookies.get('access_token')?.value || req.headers.get('authorization')?.split(' ')[1];
  if (token) {
    try {
      const payload = await verifyJwt(token);

      const actor = actorFromPayload(payload);
      res.headers.set('x-user-id', actor?.id!);
      res.headers.set('x-user-role', actor?.role!);
    } catch {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }
  }

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0] ?? req.headers.get('x-real-ip') ?? '0.0.0.0';
  // 3. Rate Limit
  const limited = await rateLimit(ip, 10);
  if (!limited.success) {
    return NextResponse.json(new ApiError(429, 'Too many requests'), { status: 429 });
  }

  // 4. Observability: add request ID
  const requestId = crypto.randomUUID();
  res.headers.set('x-request-id', requestId);

  return res;
}

// Apply middleware only to API & app routes
export const config = {
  matcher: ['/api/:path*', '/app/:path*'],
};
