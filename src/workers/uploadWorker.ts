// worker/upload.worker.ts
import { Queue, Worker, Job } from 'bullmq';
import prisma from '@/lib/prisma';
import { processUploadAndSave } from '@/lib/cloudinary';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { fileTypeFromFile, FileTypeResult } from 'file-type';
import clamd from 'clamdjs';
import pino from 'pino';
import Sentry from '@sentry/node';
import { ApiError } from '@/utils/NextApiError';
import { connection } from '@/lib/redis';
import { Upload as UploadModule } from '@/app/generated/prisma/client/client';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const queueName = process.env.UPLOAD_QUEUE_NAME ?? 'upload-queue';
const queue = new Queue(queueName, { connection });

type UploadJobData = {
  uploadId: number | string;
};

type WorkerResult =
  | { alreadyUploaded: true; publicId?: string | null; url?: string | null }
  | { success: true; upload?: UploadModule }
  | { error: string };

/** allowed mime set */
const ALLOWED_MIME = new Set<string>([
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

function isAllowed(mime?: string): boolean {
  if (!mime) return false;
  return ALLOWED_MIME.has(mime);
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      // not found is fine; otherwise surface the error to logs
      logger.warn({ err: e, filePath }, 'safeUnlink: unexpected error');
    }
  }
}

const worker = new Worker<UploadJobData, WorkerResult>(
  queueName,
  async (job: Job<UploadJobData>): Promise<WorkerResult> => {
    const uploadIdNum = Number(job.data.uploadId);
    if (!Number.isInteger(uploadIdNum) || uploadIdNum <= 0) {
      throw new ApiError(400, 'uploadId must be a positive integer.');
    }

    const uploadRow = await prisma.upload.findUnique({ where: { id: uploadIdNum } });
    if (!uploadRow) throw new ApiError(404, 'Upload record not found');

    if (uploadRow.status === 'UPLOADED') {
      logger.info({ uploadId: uploadIdNum }, 'job skipped - already uploaded');
      return {
        alreadyUploaded: true,
        publicId: uploadRow.publicId ?? null,
        url: uploadRow.url ?? null,
      };
    }

    await prisma.upload.update({
      where: { id: uploadIdNum },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    });

    const baseUploadsDir = path.resolve(process.cwd(), 'uploads');
    const absPath = path.resolve(process.cwd(), String(uploadRow.localPath ?? ''));

    if (!absPath.startsWith(baseUploadsDir)) {
      await prisma.upload.update({
        where: { id: uploadIdNum },
        data: { status: 'FAILED', errorMessage: 'Invalid local path' },
      });
      throw new ApiError(500, 'Invalid local path');
    }

    try {
      await fs.access(absPath);
    } catch (e) {
      await prisma.upload.update({
        where: { id: uploadIdNum },
        data: { status: 'FAILED', errorMessage: 'Local file missing' },
      });
      throw new ApiError(500, 'Local file missing');
    }

    // sniff MIME
    let ft: FileTypeResult | undefined;
    try {
      ft = await fileTypeFromFile(absPath);
    } catch (err) {
      logger.warn(
        { err, uploadId: uploadIdNum },
        'file-type sniff failed, proceeding to check mimetype fallback'
      );
    }

    const detectedMime = ft?.mime ?? uploadRow.mimeType ?? undefined;
    if (!isAllowed(detectedMime)) {
      await prisma.upload.update({
        where: { id: uploadIdNum },
        data: { status: 'FAILED', errorMessage: `Invalid file type ${detectedMime ?? 'unknown'}` },
      });
      await safeUnlink(absPath);
      return { error: 'invalid_file_type' };
    }

    // ClamAV scan
    try {
      const clamdHost = process.env.CLAMAV_HOST ?? '127.0.0.1';
      const clamdPort = Number(process.env.CLAMAV_PORT ?? 3310);
      const scanner = clamd.createScanner(clamdHost, clamdPort);

      const scanResult = await scanner.scanFile(absPath);
      if (scanResult?.is_infected) {
        await prisma.upload.update({
          where: { id: uploadIdNum },
          data: { status: 'FAILED', errorMessage: 'File infected' },
        });
        await safeUnlink(absPath);
        return { error: 'infected' };
      }
    } catch (err) {
      logger.warn({ err, uploadId: uploadIdNum }, 'ClamAV scan failed — proceeding with caution');
      // Policy: proceed but mark scanFallback true (optional)
      try {
        await prisma.upload.update({
          where: { id: uploadIdNum },
          data: { meta: { uploadRow: uploadRow.meta, scanFallback: true } },
        });
      } catch (updateErr) {
        logger.warn({ updateErr }, 'failed to mark scanFallback on upload row');
      }
    }

    // upload via cloudinary.ts helper which handles streaming and DB update logic
    try {
      // call processUploadAndSave which uploads and updates DB (typed)
      const updatedUpload = await processUploadAndSave(uploadIdNum);

      // remove local file after successful DB update
      await safeUnlink(absPath);

      logger.info({ uploadId: uploadIdNum, publicId: updatedUpload.publicId }, 'upload success');
      return { success: true, upload: updatedUpload };
    } catch (err) {
      console.log(err);
      const message = err instanceof ApiError ? err.message : String(err);
      // update DB with failure (preserve local file for retry/inspection)
      try {
        await prisma.upload.update({
          where: { id: uploadIdNum },
          data: { status: 'FAILED', errorMessage: message },
        });
      } catch (updateErr) {
        logger.error({ updateErr }, 'failed to mark upload row as FAILED');
      }

      logger.error(
        { err, uploadId: uploadIdNum },
        'upload to cloud failed — job will be retried if attempts remain'
      );
      Sentry.captureException(message);
      // rethrow so BullMQ applies backoff and retry
      throw err as ApiError;
    }
  },
  {
    connection,
    concurrency: Number(process.env.UPLOAD_WORKER_CONCURRENCY ?? 2),
    lockDuration: Number(process.env.UPLOAD_WORKER_LOCK_DURATION ?? 5 * 60 * 1000),
  }
);

worker.on('completed', (job) => logger.info({ jobId: job.id }, 'job completed'));
worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'job failed');
  Sentry.captureException(
    err instanceof ApiError ? new ApiError(err.statusCode, String(err)) : new Error(err.message)
  );
});

async function shutdown(): Promise<void> {
  logger.info('closing worker and connections...');
  try {
    await worker.close();
    await queue.close();
    await connection.quit();
  } catch (err) {
    logger.warn({ err }, 'error during shutdown');
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { worker, queue };
