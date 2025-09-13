import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import prisma from '@/lib/prisma';
import cloudinary from '@/lib/cloudinary';
import path from 'path';
import fs from 'fs';
import { fileTypeFromFile } from 'file-type';
import clamd from 'clamdjs'; // or use external AV API
import { ApiError } from '@/utils/NextApiError';

const connection = new Redis(process.env.REDIS_URL!);
const worker = new Worker(
  process.env.UPLOAD_QUEUE_NAME!,
  async (job: Job) => {
    const uploadId: number = Number(job.data.uploadId);
    if (!Number(uploadId)) {
      throw new ApiError(500, 'uploadId must be a number.');
    }
    const uploadRow = await prisma.upload.findUnique({ where: { id: uploadId } });
    if (!uploadRow) throw new ApiError(404, 'Upload record not found');

    // Prevent double-processing
    if (uploadRow.status === 'uploaded') return;

    // update status -> processing
    await prisma.upload.update({
      where: { id: uploadId },
      data: { status: 'processing', attempts: { increment: 1 } },
    });

    const absPath = path.join(process.cwd(), uploadRow.localPath);
    if (!fs.existsSync(absPath)) {
      await prisma.upload.update({
        where: { id: uploadId },
        data: { status: 'failed', errorMessage: 'Local file missing' },
      });
      throw new Error('Local file missing');
    }

    // 1) sniff actual mime
    const ft = await fileTypeFromFile(absPath);
    if (ft && !isAllowed(ft.mime)) {
      await prisma.upload.update({
        where: { id: uploadId },
        data: { status: 'failed', errorMessage: `Invalid file type ${ft.mime}` },
      });
      // optionally remove local file if malicious
      return;
    }

    // 2) antivirus scan (example: using clamav)
    try {
      // optional: stream to clamd scan
      const clamdScanner = clamd.createScanner(
        process.env.CLAMAV_HOST || '127.0.0.1',
        Number(process.env.CLAMAV_PORT || 3310)
      );
      const { is_infected } = await clamdScanner.scanFile(absPath);
      if (is_infected) {
        await prisma.upload.update({
          where: { id: uploadId },
          data: { status: 'failed', errorMessage: 'File infected' },
        });
        return;
      }
    } catch (err) {
      console.warn('ClamAV error, proceeding with caution', err);
      // decide policy: either block or continue
    }

    // 3) upload to Cloudinary
    try {
      const tenantFolder = `${process.env.CLOUD_FOLDER_PREFIX}/${uploadRow.tenantId}/${uploadRow.purpose}`;
      const result = await cloudinary.uploader.upload(absPath, {
        folder: tenantFolder,
        resource_type: 'auto',
        use_filename: false,
        unique_filename: true,
        overwrite: false,
      });

      // update db with cloud info & mark uploaded
      await prisma.upload.update({
        where: { id: uploadId },
        data: {
          status: 'uploaded',
          publicId: result.public_id,
          url: result.secure_url,
          size: result.bytes ?? uploadRow.size,
        },
      });

      // delete local file
      try {
        fs.unlinkSync(absPath);
      } catch (e) {
        console.warn('unlink failed', e);
      }

      return result;
    } catch (err) {
      // update DB, leave file for retry
      const errMsg = (err as Error).message;
      await prisma.upload.update({
        where: { id: uploadId },
        data: { status: 'failed', errorMessage: errMsg },
      });
      throw err; // so BullMQ can retry according to attempts/backoff
    }
  },
  { connection }
);

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
  ]); // same set as earlier
  return ALLOWED.has(mime);
}

// handle worker events for logging
worker.on('failed', (job, err) => {
  console.error('Job failed', job!.id, err);
});

// optional graceful shutdown...
