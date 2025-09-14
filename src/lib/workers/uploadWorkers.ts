// worker/upload.worker.ts
import { Queue, QueueScheduler, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import prisma from '@/lib/prisma';
import cloudinary from '@/lib/cloudinary';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { fileTypeFromFile } from 'file-type';
import clamd from 'clamdjs';
import pino from 'pino'; // or your logger
import Sentry from '@sentry/node'; // optional monitoring
import { ApiError } from '@/utils/NextApiError';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// Configure redis connection once and reuse
const connection = new IORedis(process.env.REDIS_URL!);

// Create a QueueScheduler so delayed/stalled jobs are handled
const queueName = process.env.UPLOAD_QUEUE_NAME!;
const queueScheduler = new QueueScheduler(queueName, { connection });

// Optionally create a Queue object if you need to add/remove jobs from here
const queue = new Queue(queueName, { connection });

// Define the Job data interface for TypeScript safety
type UploadJobData = {
  uploadId: number | string;
  // any other metadata you enqueue
};

// Create the worker, typed with Job data + return type
const worker = new Worker<UploadJobData, any>(
  queueName,
  async (job: Job<UploadJobData>) => {
    const uploadId = Number(job.data.uploadId);
    if (!Number.isInteger(uploadId) || uploadId <= 0) {
      throw new ApiError(400, 'uploadId must be a positive integer.');
    }

    // Fetch the upload row fresh inside the job
    const uploadRow = await prisma.upload.findUnique({ where: { id: uploadId } });
    if (!uploadRow) throw new ApiError(404, 'Upload record not found');

    // Idempotency guard: if already uploaded successfully, return stored info
    if (uploadRow.status === 'UPLOADED') {
      logger.info({ uploadId }, 'job skipped - already uploaded');
      return { alreadyUploaded: true, publicId: uploadRow.publicId, url: uploadRow.url };
    }

    // Mark processing early to avoid dupes (small race: handled by idempotency above)
    await prisma.upload.update({
      where: { id: uploadId },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    });

    const baseUploadsDir = path.resolve(process.cwd(), 'uploads'); // tune to your layout
    const absPath = path.resolve(process.cwd(), String(uploadRow.localPath));
    // Security: ensure absPath is inside baseUploadsDir (prevent path traversal)
    if (!absPath.startsWith(baseUploadsDir)) {
      await prisma.upload.update({
        where: { id: uploadId },
        data: { status: 'FAILED', errorMessage: 'Invalid local path' },
      });
      throw new ApiError(500, 'Invalid local path');
    }

    // Check file existence (async)
    try {
      await fs.access(absPath);
    } catch (e) {
      await prisma.upload.update({
        where: { id: uploadId },
        data: { status: 'FAILED', errorMessage: 'Local file missing' },
      });
      throw new ApiError(500, 'Local file missing');
    }

    // 1) Sniff actual MIME using file-type (reads magic bytes).
    const ft = await fileTypeFromFile(absPath);
    if (!isAllowed(ft?.mime)) {
      await prisma.upload.update({
        where: { id: uploadId },
        data: { status: 'FAILED', errorMessage: `Invalid file type ${ft?.mime ?? 'unknown'}` },
      });
      // Optionally delete local file here if policy allows
      await safeUnlink(absPath);
      return { error: 'invalid_file_type' };
    }

    // 2) Antivirus scan (clamd) — use scanFile or stream scan if possible
    try {
      const clamdHost = process.env.CLAMAV_HOST ?? '127.0.0.1';
      const clamdPort = Number(process.env.CLAMAV_PORT ?? 3310);
      const scanner = clamd.createScanner(clamdHost, clamdPort);

      // scanFile returns e.g. { is_infected: boolean, viruses: string[] }
      const scanResult = await scanner.scanFile(absPath);
      if (scanResult?.is_infected) {
        await prisma.upload.update({
          where: { id: uploadId },
          data: { status: 'FAILED', errorMessage: 'File infected' },
        });
        await safeUnlink(absPath);
        return { error: 'infected' };
      }
    } catch (err) {
      // If ClamAV is down, decide policy — here we log and continue (configurable)
      logger.warn({ err }, 'ClamAV scan failed — proceeding with caution');
      // Optionally: fail the job to retry later, or set a flag: uploadRow.scanFallbackAttempted = true
    }

    // 3) Upload to Cloudinary using stream (memory-friendly)
    try {
      // Build destination folder carefully, sanitize values
      const tenantIdSafe = String(uploadRow.tenantId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const purposeSafe = String(uploadRow.purpose ?? 'misc').replace(/[^a-zA-Z0-9_-]/g, '_');
      const tenantFolder = `${
        process.env.CLOUD_FOLDER_PREFIX ?? 'app_uploads'
      }/${tenantIdSafe}/${purposeSafe}`;

      // Using upload_stream avoids buffering entire file in memory
      const streamUpload = () =>
        new Promise<any>((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: tenantFolder,
              resource_type: 'auto',
              use_filename: false,
              unique_filename: true,
              overwrite: false,
            },
            (error: Error | undefined, result: any) => {
              if (error) return reject(error);
              resolve(result);
            }
          );
          createReadStream(absPath).pipe(stream);
        });

      const result = await streamUpload();

      // Update DB and mark uploaded (wrap in transaction if you have related updates)
      await prisma.upload.update({
        where: { id: uploadId },
        data: {
          status: 'UPLOADED',
          publicId: result.public_id,
          url: result.secure_url,
          size: result.bytes ?? uploadRow.size,
          // optionally: metadata, width/height, format etc.
        },
      });

      // delete local file async (log but don't block final return)
      await safeUnlink(absPath).catch((e) =>
        logger.warn({ err: e }, 'failed to unlink local file')
      );

      logger.info({ uploadId, publicId: result.public_id }, 'upload success');
      return { success: true, result };
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      // Update DB: mark failed, preserve local file for debugging/retry policy
      await prisma.upload.update({
        where: { id: uploadId },
        data: { status: 'FAILED', errorMessage: errMsg },
      });
      logger.error({ err }, 'upload to cloud failed — job will be retried (if configured)');
      // rethrow so BullMQ can apply attempts/backoff and retry rules
      throw err;
    }
  },
  {
    connection,
    // tune concurrency and lock duration as needed
    concurrency: Number(process.env.UPLOAD_WORKER_CONCURRENCY ?? 2),
    lockDuration: 5 * 60 * 1000, // 5 minutes
  }
);

// Generic worker event handlers for observability
worker.on('completed', (job) => logger.info({ jobId: job.id }, 'job completed'));
worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'job failed');
  // optionally send to Sentry
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
});

// Graceful shutdown helper
async function shutdown() {
  logger.info('closing worker and connections...');
  await worker.close();
  await queueScheduler.close();
  await queue.close();
  await connection.quit();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// helper: safe unlink (ignore missing file)
async function safeUnlink(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    // ignore already-missing file
  }
}

// allowed mime list
function isAllowed(mime?: string) {
  if (!mime) return false;
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
  return ALLOWED.has(mime);
}

export { worker, queue, queueScheduler };
