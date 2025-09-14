import { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import { upload } from '@/middlewares/upload'; // multer instance
import runMiddleware from '@/lib/helpers/runMiddleware'; // your helper
import prisma from '@/lib/prisma';
import { uploadQueue } from '@/lib/helpers/queues'; // BullMQ producer
import { existsSync } from 'fs';
import { ApiError } from '@/utils/NextApiError';

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: '10mb',
  },
};
// Configuration
const TEMP_UPLOAD_DIR = path.join(process.cwd(), 'public/temp');
const MAX_FILES = 10;

// export const config = {
//   api: {
//     bodyParser: false,
//     sizeLimit: '10mb',
//   },
// };

// Type safety
interface UploadedFile {
  url: string;
  public_id: string;
}

interface UploadResponse {
  success: boolean;
  uploads: UploadedFile[];
  metadata?: {
    totalFiles: number;
    totalSize: number;
    processingTime: string;
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const startTime = Date.now();
  try {
    // 1. Method check
    if (req.method !== 'POST') {
      res.setHeader('Allow', ['POST']);
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const tenantId = req.headers['x-tenant-id'] as string;
    const userId = req.headers['x-user-id'] as string;

    if (!tenantId) res.status(400).json(new ApiError(400, 'Tenant Id is required'));
    if (!userId) res.status(400).json(new ApiError(400, 'User Id is required'));

    // 2. Create temp directory if not exists
    if (!existsSync(TEMP_UPLOAD_DIR)) await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });

    // 3. Process upload based on headers
    const isMultiple = req.headers['x-upload-multiple'] === 'true';
    await runMiddleware(
      req,
      res,
      isMultiple ? upload.array('files', MAX_FILES) : upload.single('file')
    );

    // 4. Get files with type safety (fix type assertion error)
    let files: Express.Multer.File[];

    if (isMultiple) {
      files = (req as unknown as { files: Express.Multer.File[] }).files;
    } else {
      const singleFile = (req as unknown as { file?: Express.Multer.File }).file;
      files = singleFile ? [singleFile] : [];
    }

    if (!files || files.length === 0 || files.some((file) => !file)) {
      return res.status(400).json({ error: 'No valid files uploaded' });
    }

    const created: any[] = [];
    // Start transaction for DB create + enqueue to ensure consistency
    for (const f of files) {
      const localRelPath = path.relative(process.cwd(), f.path);
      // create DB record
      const db = await prisma.upload.create({
        data: {
          tenantId,
          userId,
          purpose: (req.headers['x-file-purpose'] as string) || 'misc',
          originalName: f.originalname,
          filename: f.filename,
          localPath: localRelPath,
          mimeType: f.mimetype,
          size: f.size,
          status: 'PENDING',
        },
      });

      // enqueue job
      await uploadQueue.add(
        'upload-to-cloud',
        { uploadId: db.id },
        {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        }
      );

      created.push(db);

      // 6. Calculate metadata
      const totalSize = files.reduce((sum, file) => sum + file.size, 0);
      const processingTime = `${Date.now() - startTime}ms`;

      // 7. Successful response
      return res.status(200).json({
        success: true,
        uploads: created,
        metadata: {
          totalFiles: files.length,
          totalSize,
          processingTime,
        },
      });
    }
  } catch (err) {
    console.error('Upload Error:', {
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    if (err instanceof Error) {
      // Specific error handling
      // TypeScript ko nahi pata ke 'err' pe 'code' property ho sakti hai, is liye type guard use karo
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: unknown }).code === 'LIMIT_FILE_SIZE'
      ) {
        return res.status(413).json({
          error: `File too large. Maximum size is ${10 / 1024 / 1024}MB`,
        });
      }

      // Type guard use karo, lekin 'any' ki bajaye safer type assertion use karo
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: unknown }).code === 'LIMIT_FILE_COUNT'
      ) {
        return res.status(400).json({
          error: `Too many files. Maximum ${MAX_FILES} allowed`,
        });
      }
    }
    return res.status(500).json({
      error: 'File upload failed. Please try again.',
    });
  }
}
