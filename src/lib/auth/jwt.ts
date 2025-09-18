// lib/auth/jwt.ts
/**
 * JWT helpers using `jose`
 *
 * - Supports:
 *   - Signing with symmetric secret (HS256) when JWT_SECRET is provided
 *   - Signing/verification with RSA/EC keys (RS256/ES256) when JWT_PRIVATE_KEY / JWT_PUBLIC_KEY (PEM) are provided
 *   - Remote JWKS verification when JWKS_URI is provided (rotating keys supported)
 *
 * - Exports:
 *   - signAccessToken(actor, opts) -> string (JWT)
 *   - verifyJwt(token) -> { payload, protectedHeader }
 *   - getTokenFromRequest(req) -> string | undefined
 *
 * Notes:
 *  - Keep private keys/secret in Secrets Manager (or env for small setups)
 *  - Tokens issued include `sub`, `role`, `tenantId`, `ip`, `userAgent` (if provided)
 */

import type { NextApiRequest } from 'next';
import {
  jwtVerify,
  SignJWT,
  importPKCS8,
  importSPKI,
  importJWK,
  createRemoteJWKSet,
  generateSecret,
  type JWTVerifyResult,
  type JWTVerifyOptions,
  type KeyObject,
} from 'jose';

import type { Actor } from '@/types/userTypes';

const DEFAULT_ALG = 'HS256'; // fallback algorithm for symmetric secret

// env: prefer JWKS URI > RSA/EC keys > symmetric secret
const JWKS_URI = process.env.JWKS_URI; // e.g. https://example.com/.well-known/jwks.json
const PRIVATE_KEY_PEM = process.env.JWT_PRIVATE_KEY; // PKCS8 PEM for signing (RS/ES)
const PUBLIC_KEY_PEM = process.env.JWT_PUBLIC_KEY; // SPKI PEM for verification
const JWT_SECRET = process.env.JWT_SECRET; // symmetric secret (HS256)
const ACCESS_TOKEN_EXP = process.env.ACCESS_TOKEN_EXP ?? '15m'; // string accepted by jose (e.g. '15m', '1h')

// internal cached verifier / key
let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let publicKeyCached: KeyObject | undefined;
let signingKeyAvailable = false;
let signingAlg: string | undefined;

/**
 * Initialize keying strategy based on available env vars.
 * Called lazily on first operation.
 */
async function ensureKeySetup(): Promise<void> {
  if (remoteJwks || publicKeyCached || JWT_SECRET) return;

  if (JWKS_URI) {
    // createRemoteJWKSet will handle caching & rotation
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    remoteJwks = createRemoteJWKSet(new URL(JWKS_URI));
    signingAlg = undefined; // unknown (depends on kid)
    return;
  }

  if (PUBLIC_KEY_PEM) {
    // import public key (SPKI for verification)
    // try RS256 first; jose will infer alg when verifying as long as key is compatible
    publicKeyCached = await importSPKI(String(PUBLIC_KEY_PEM), 'RS256').catch(async () =>
      // fallback: try ES256 import
      importSPKI(String(PUBLIC_KEY_PEM), 'ES256').catch(() => undefined)
    );
  }

  if (JWT_SECRET) {
    // symmetric secret
    // jose accepts Uint8Array secret; generateSecret returns a key but we can use raw secret too
    // We'll use raw secret string for signing via SignJWT .setProtectedHeader({ alg: 'HS256' }) and verify using remoteJwks? no
    signingAlg = DEFAULT_ALG;
  }

  // If PRIVATE_KEY_PEM present and no JWT_SECRET, try to import it for signing
  if (PRIVATE_KEY_PEM && !signingAlg) {
    // try RS256 (PKCS8)
    try {
      // importPKCS8 returns a KeyLike usable for signing; but we don't need to store it here for verify,
      // because signing happens in sign function directly using the PEM string.
      signingAlg = 'RS256';
      signingKeyAvailable = true;
    } catch {
      signingAlg = undefined;
    }
  }
}

/**
 * Extract token from Authorization header (Bearer) or cookie `access_token`.
 * Prefer Authorization header.
 */
export function getTokenFromRequest(req: NextApiRequest): string | undefined {
  const authHeader = req.headers.authorization ?? req.headers.Authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  // Next.js cookies: req.cookies in edge runtime different; here generic
  // Try cookies (NextApiRequest has cookies property in Next.js API)
  // @ts-ignore
  const cookies = (req.cookies ?? (req as any).cookie ?? {}) as Record<string, string>;
  return cookies['access_token'] ?? undefined;
}

/**
 * Sign an access token for an Actor.
 *
 * payload fields added:
 *  - sub (actor.id)
 *  - role
 *  - tenantId
 *  - iat / exp set by jose
 *
 * opts:
 *  - expiresIn: string (e.g. '15m', '1h')
 *  - extra: object of additional claims (e.g., ip, userAgent)
 */
export async function signAccessToken(
  actor: Actor,
  opts?: { expiresIn?: string; extra?: Record<string, unknown> }
): Promise<string> {
  await ensureKeySetup();

  const expiresIn = opts?.expiresIn ?? ACCESS_TOKEN_EXP;
  const extra = opts?.extra ?? {};

  const payload = {
    sub: actor.id,
    role: actor.role,
    tenantId: actor.tenantId,
    ...extra,
  };

  // Prefer PRIVATE_KEY_PEM RS/ES signing, else symmetric secret
  if (PRIVATE_KEY_PEM) {
    // Determine algorithm by examining key header (simple heuristic: "BEGIN EC" => ES256, "BEGIN PRIVATE KEY" or "BEGIN RSA PRIVATE KEY" => RS256)
    const pem = String(PRIVATE_KEY_PEM);
    const alg =
      pem.includes('BEGIN EC') || pem.includes('BEGIN EC PRIVATE KEY') ? 'ES256' : 'RS256';

    // importPKCS8 expects PKCS8 (BEGIN PRIVATE KEY), many RSA keys are PKCS8. If user has different format, they should provide PKCS8.
    const privateKey = await importPKCS8(pem, alg as 'RS256' | 'ES256').catch(() => {
      throw new Error(
        'Failed to import JWT_PRIVATE_KEY; ensure it is PKCS8 PEM for RS/ES algorithms'
      );
    });

    const jwt = await new SignJWT(payload)
      .setProtectedHeader({ alg })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);

    return jwt;
  }

  if (JWT_SECRET) {
    // HMAC sign (HS256)
    const alg = 'HS256';
    // jose SignJWT requires a KeyLike for HMAC; import raw secret as key
    // We import JWK with k as base64url(secret) is another option; simpler: use a crypto key from generateSecret? but generateSecret creates a random key.
    // Use importJWK with KTY OCT:
    const secret = String(JWT_SECRET);
    // create a JWK-like object for OCT
    const jwk = { kty: 'oct', k: Buffer.from(secret).toString('base64') };
    const key = await importJWK(jwk, alg);

    const jwt = await new SignJWT(payload)
      .setProtectedHeader({ alg })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(key);

    return jwt;
  }

  throw new Error(
    'No signing key configured for JWTs. Set JWT_PRIVATE_KEY or JWT_SECRET or JWKS_URI.'
  );
}

/**
 * Verify a JWT and return payload & protected header.
 * Works with:
 *  - remote JWKS (if JWKS_URI provided)
 *  - PUBLIC_KEY_PEM (SPKI)
 *  - JWT_SECRET (HS256)
 */
export async function verifyJwt(
  token: string,
  opts?: Partial<JWTVerifyOptions>
): Promise<{ payload: Record<string, unknown>; protectedHeader: Record<string, unknown> }> {
  await ensureKeySetup();

  const verifyOpts: JWTVerifyOptions = {
    // Acceptable algorithms can be restricted; leave undefined to allow jose to infer from key
    // audience / issuer checks can be added via opts
    ...opts,
  };

  // 1) Remote JWKS if available
  if (remoteJwks) {
    const { payload, protectedHeader } = await jwtVerify(token, remoteJwks, verifyOpts);
    return { payload: payload as Record<string, unknown>, protectedHeader: protectedHeader as any };
  }

  // 2) PUBLIC_KEY_PEM (import SPKI). We attempt RS256 then ES256
  if (PUBLIC_KEY_PEM) {
    const pub = String(PUBLIC_KEY_PEM);
    // try RS256 then ES256
    try {
      const key = await importSPKI(pub, 'RS256');
      const { payload, protectedHeader } = await jwtVerify(token, key, verifyOpts);
      return {
        payload: payload as Record<string, unknown>,
        protectedHeader: protectedHeader as any,
      };
    } catch {
      // try ES256
      try {
        const key = await importSPKI(pub, 'ES256');
        const { payload, protectedHeader } = await jwtVerify(token, key, verifyOpts);
        return {
          payload: payload as Record<string, unknown>,
          protectedHeader: protectedHeader as any,
        };
      } catch (e) {
        throw new Error(
          'JWT verification failed with provided PUBLIC_KEY_PEM: ' + (e as Error).message
        );
      }
    }
  }

  // 3) HMAC secret
  if (JWT_SECRET) {
    const alg = 'HS256';
    const jwk = { kty: 'oct', k: Buffer.from(String(JWT_SECRET)).toString('base64') };
    const key = await importJWK(jwk, alg);
    const { payload, protectedHeader } = await jwtVerify(token, key, verifyOpts);
    return { payload: payload as Record<string, unknown>, protectedHeader: protectedHeader as any };
  }

  throw new Error(
    'No verification key configured for JWTs. Set JWKS_URI or PUBLIC_KEY_PEM or JWT_SECRET.'
  );
}

/**
 * Convenience: parse actor info from verified token payload.
 * Returns minimal Actor-like object if present.
 */
export function actorFromPayload(
  payload: Record<string, unknown> | undefined
): Partial<Actor> | null {
  if (!payload) return null;
  const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
  const role = typeof payload.role === 'string' ? (payload.role as Actor['role']) : undefined;
  const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : undefined;
  const ip = typeof payload.ip === 'string' ? payload.ip : undefined;
  const userAgent = typeof payload.userAgent === 'string' ? payload.userAgent : undefined;

  if (!sub) return null;
  return {
    id: sub,
    role: role ?? ('Developer' as Actor['role']),
    tenantId: tenantId ?? '' /* ip, userAgent optional */,
  } as Partial<Actor>;
}

/**
 * Simple helper to verify token from request and return actor + raw payload
 */
export async function getActorFromRequest(req: NextApiRequest) {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  try {
    const { payload } = await verifyJwt(token);
    const actor = actorFromPayload(payload);
    return { actor, payload };
  } catch (err) {
    // do not throw here; caller can decide to require auth
    return null;
  }
}

/**
 * Utility: create a JWK for HMAC secret (rarely needed externally)
 */
export async function importHmacKeyFromSecret(secret: string) {
  const alg = 'HS256';
  const jwk = { kty: 'oct', k: Buffer.from(secret).toString('base64') };
  return importJWK(jwk, alg);
}

/** Exports */
export default {
  signAccessToken,
  verifyJwt,
  getTokenFromRequest,
  getActorFromRequest,
  actorFromPayload,
  importHmacKeyFromSecret,
};
