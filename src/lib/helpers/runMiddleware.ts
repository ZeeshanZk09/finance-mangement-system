// lib/runMiddleware.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '@/utils/NextApiError';

/**
 * Run an express-style middleware (like multer) inside Next.js API route.
 * Usage:
 *   await runMiddleware(req, res, upload.single('file'))
 */
export default function runMiddleware(
  req: NextApiRequest,
  res: NextApiResponse,
  fn: (req: Request, res: Response, next: NextFunction) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    // adapt req/res to express types
    const reqAny = req as unknown as Request;
    const resAny = res as unknown as Response;

    fn(reqAny, resAny, (result?: any) => {
      if (result instanceof ApiError) {
        console.log(result);
        return reject(result);
      }
      return resolve();
    });
  });
}
