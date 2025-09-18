// src/pages/api/uploads/delete.ts  (or wherever your route lives)
import path from 'path';
import fs from 'fs/promises';
import cloudinary from '@/lib/cloudinary';
import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiError } from '@/utils/NextApiError';
import { ApiSuccess } from '@/utils/NextApiSuccess';
import { DeleteErrorResponse, DeleteSuccessResponse } from '@/types/imageTypes';
import prisma from '@/lib/prisma';
import pino from 'pino';
import * as Sentry from '@sentry/node';

const logger = pino({ level: process.env.LOG_LEVEL });

// base temp directory (ensure this matches how you save files)
const TEMP_UPLOAD_DIR = path.join(process.cwd(), 'public', 'temp');

function makeAbsoluteLocalPath(localPath: string): string {
  if (path.isAbsolute(localPath)) return localPath;
  return path.join(process.cwd(), localPath);
}

async function safeUnlink(filePath: string): Promise<{ deleted: boolean; reason?: string }> {
  try {
    await fs.unlink(filePath);
    return { deleted: true };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { deleted: false, reason: 'ENOENT' };
    }
    // rethrow other errors
    throw err;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<DeleteSuccessResponse | DeleteErrorResponse | { error: string }>
) {
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', ['DELETE']);
    return res.status(405).json(new ApiError(405, 'Method not allowed'));
  }

  try {
    const { filename, public_id } = req.query;
    const tenantId = (req.headers['x-tenant-id'] as string) || '';
    const userId = (req.headers['x-user-id'] as string) || '';

    // Validate required headers
    if (!tenantId) return res.status(400).json(new ApiError(400, 'Tenant Id is required'));
    if (!userId) return res.status(400).json(new ApiError(400, 'User Id is required'));

    // At least one identifier must be provided
    if (!filename && !public_id) {
      return res.status(400).json(new ApiError(400, 'Either filename or public_id is required'));
    }

    // Find upload row for this tenant & user
    const whereClause: any = {
      tenantId,
      userId,
      // allow matching on either localPath or publicId
      ...(filename ? { localPath: { endsWith: String(filename) } } : {}),
      ...(public_id ? { publicId: String(public_id) } : {}),
    };

    // Try to find the upload entry (first match)
    const found = await prisma.upload.findFirst({
      where: whereClause,
    });

    if (!found) {
      return res.status(404).json(new ApiError(404, 'File not found or access denied'));
    }

    const foundPublicId = found.publicId ?? null;
    const foundLocalPath = found.localPath ?? null;

    // Track deletion outcomes
    const deletionResult = {
      cloudinary: { deleted: false, note: '' as string | null },
      local: { deleted: false, note: '' as string | null },
    };

    // 1) Delete from Cloudinary if publicId exists or public_id provided
    if (foundPublicId || public_id) {
      const pid = String(foundPublicId ?? public_id);
      try {
        // cloudinary.uploader.destroy usually returns { result: 'ok' } or { result: 'not found' }
        const resp = await cloudinary.uploader.destroy(pid);
        const result = (resp && (resp as any).result) ?? (resp as any);
        if (result === 'ok') {
          deletionResult.cloudinary = { deleted: true, note: 'deleted' };
        } else if (result === 'not found' || result === 'not_found') {
          deletionResult.cloudinary = { deleted: false, note: 'not_found' };
        } else {
          deletionResult.cloudinary = { deleted: false, note: String(result) };
        }
      } catch (err: any) {
        // log & attach note, but continue to local deletion attempt
        logger.error({ err, uploadId: found.id }, 'Cloudinary destroy error');
        Sentry.captureException(err);
        deletionResult.cloudinary = { deleted: false, note: err?.message ?? 'error' };
      }
    }

    // 2) Delete local file if present
    if (foundLocalPath) {
      const absPath = makeAbsoluteLocalPath(foundLocalPath);

      // Security: ensure localPath stays within TEMP_UPLOAD_DIR (prevent traversal)
      const normalizedBase = path.normalize(TEMP_UPLOAD_DIR + path.sep);
      const normalizedTarget = path.normalize(absPath + path.sep);

      if (!normalizedTarget.startsWith(normalizedBase)) {
        // suspicious path - do NOT delete; mark failure
        deletionResult.local = { deleted: false, note: 'unsafe_path' };
        logger.warn(
          { absPath, normalizedBase, normalizedTarget },
          'Attempted delete outside temp dir'
        );
      } else {
        try {
          const unlinkResult = await safeUnlink(absPath);
          if (unlinkResult.deleted) {
            deletionResult.local = { deleted: true, note: 'deleted' };
          } else {
            deletionResult.local = { deleted: false, note: unlinkResult.reason ?? 'missing' };
          }
        } catch (err: any) {
          // error while unlinking (permission etc.)
          logger.error({ err, absPath, uploadId: found.id }, 'Local file unlink error');
          Sentry.captureException(err);
          deletionResult.local = { deleted: false, note: err?.message ?? 'unlink_error' };
        }
      }
    }

    // 3) Decide update to DB based on deletion outcomes
    // We will set status='DELETED' if cloudinary was deleted OR local deleted.
    // Keep record of what succeeded for audit.
    const now = new Date();
    const updateData: any = {
      updatedAt: now,
    };

    // If both cloud & local successfully deleted, mark removed & clear keys (optional)
    if (deletionResult.cloudinary.deleted || deletionResult.local.deleted) {
      updateData.status = 'DELETED';
      updateData.deletedAt = now;
      // Optionally clear storage keys but keep them if you want audit info
      updateData.publicId = deletionResult.cloudinary.deleted ? null : found.publicId;
      updateData.localPath = deletionResult.local.deleted ? null : found.localPath;
      updateData.meta = {
        found: found.meta,
        deletion: deletionResult,
      };
    } else {
      // neither deleted (cloud not found or local missing); keep status but store last failure message
      updateData.status = found.status;
      updateData.errorMessage = `delete_failed: cloud=${deletionResult.cloudinary.note}, local=${deletionResult.local.note}`;
      updateData.meta = {
        found: found.meta,
        deletionAttempt: deletionResult,
      };
    }

    // Update DB
    try {
      await prisma.upload.update({
        where: { id: found.id },
        data: updateData,
      });

      // Optional: write an audit record if you have createUploadAudit
      // import and call your audit helper here, e.g.:
      // await createUploadAudit({ uploadId: found.id, tenantId, userId, action: 'deleted', previousStatus: found.status, newStatus: updateData.status, note: JSON.stringify(deletionResult) });
    } catch (dbErr: any) {
      logger.error({ dbErr, uploadId: found.id }, 'Failed to update upload row after deletion');
      Sentry.captureException(dbErr);
      // still respond to client about deletion result but warn of DB update failure
      return res
        .status(500)
        .json(new ApiError(500, 'File deletion succeeded but DB update failed. Contact support.'));
    }

    // 4) Construct response detailing what happened
    const resp = {
      success: true,
      deleted: {
        cloudinary: deletionResult.cloudinary.deleted,
        cloudinaryNote: deletionResult.cloudinary.note,
        local: deletionResult.local.deleted,
        localNote: deletionResult.local.note,
      },
      uploadId: found.id,
    };

    return res.status(200).json(ApiSuccess.ok('File deletion processed', resp));
  } catch (err: any) {
    logger.error({ err }, 'Delete Error');
    Sentry.captureException(err);
    return res.status(500).json(new ApiError(500, 'File deletion failed. Try again.'));
  }
}
