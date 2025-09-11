import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import sanitize from 'sanitize-filename';
import crypto from 'crypto';
import { Request } from 'express';
import { ApiError } from '@/utils/NextApiError';

// base temp dir
const BASE_TEMP = path.join(process.cwd(), 'public', 'temp');

// allowed mime map (same as you had)
const ALLOWED = new Set([
  'image/jpeg',
  'image/png',
  'image/jpg',
  'image/webp',
  'image/svg+xml',
  'image/gif',
  'image/tiff',
  'image/bmp',
  'image/heif',
  'image/heic',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/zip',
  'application/x-7z-compressed',
  'application/gzip',
]);

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      // derive tenant & purpose securely:
      // Prefer to get tenantId from authenticated req.user; fallback to header only if you validate it
      if (!req.headers['x-tenant-id']) return cb(new ApiError(400, 'Missing tenant id'), '');
      if (!req.headers['x-file-purpose']) return cb(new ApiError(400, 'Missing file purpose'), '');
      const tenantId = req.headers['x-tenant-id'] as string;
      const purposeRaw = (req.headers['x-file-purpose'] as string).trim().toLowerCase();

      // sanitize folder names
      const tenant = sanitize(tenantId).replace(/\s+/g, '_');
      const purpose = sanitize(purposeRaw).replace(/\s+/g, '_');

      const dir = path.join(BASE_TEMP, tenant, purpose);
      if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err as ApiError, '');
    }
  },
  filename: (req, file, cb) => {
    const safe = sanitize(file.originalname).replace(/\s+/g, '_');
    const rnd = crypto.randomBytes(6).toString('hex');
    const name = `${Date.now()}-${rnd}-${safe}`;
    cb(null, name);
  },
});

// file filter uses mime type but actual sniff done later in worker
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (!ALLOWED.has(file.mimetype)) {
    return cb(new ApiError(400, 'File type not allowed'));
  }
  cb(null, true);
};

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // default 50MB: override per route if needed
  },
});
