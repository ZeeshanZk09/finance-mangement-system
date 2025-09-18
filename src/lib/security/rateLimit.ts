// lib/security/rateLimit.ts
import { connection as redis } from '@/lib/redis';
import { ApiError } from '@/utils/NextApiError';

/**
 * Rate limiting function.
 * Uses a sliding window algorithm with Redis INCR + EXPIRE.
 *
 * @param key Unique key to identify the client (e.g. IP, tenantId:userId)
 * @param limit Number of allowed requests in the window
 * @param windowSec Time window in seconds
 *
 * @returns { remaining, reset, success }
 */
export async function rateLimit(
  key: string,
  limit = 100,
  windowSec = 60
): Promise<{ remaining: number; reset: number; success: boolean }> {
  if (!redis) {
    throw new ApiError(500, 'Redis connection not available for rate limiting');
  }

  const now = Math.floor(Date.now() / 1000); // seconds
  const windowKey = `ratelimit:${key}:${Math.floor(now / windowSec)}`;

  const tx = redis.multi();
  tx.incr(windowKey);
  tx.expire(windowKey, windowSec);
  const [count, _] = (await tx.exec()) as [number, unknown];

  const remaining = limit - count;
  const reset = (Math.floor(now / windowSec) + 1) * windowSec;

  return {
    remaining: Math.max(0, remaining),
    reset,
    success: remaining > 0,
  };
}

/**
 * Enforce rate limit by throwing if exceeded.
 * Call inside API route/middleware.
 */
export async function enforceRateLimit(key: string, limit = 100, windowSec = 60) {
  const result = await rateLimit(key, limit, windowSec);
  if (!result.success) {
    throw new ApiError(
      429,
      `Too many requests. Try again in ${Math.ceil(result.reset - Date.now() / 1000)}s`
    );
  }
  return result;
}
