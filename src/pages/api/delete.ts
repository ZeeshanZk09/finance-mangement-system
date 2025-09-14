import path from 'path';
import fs from 'fs/promises';
import cloudinary from '@/lib/cloudinary';
import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiError } from '@/utils/NextApiError';
import { ApiSuccess } from '@/utils/NextApiSuccess';
import { DeleteErrorResponse, DeleteSuccessResponse } from '@/types/imageTypes';
import prisma from '@/lib/prisma';
const TEMP_UPLOAD_DIR = path.join(process.cwd(), 'public/temp');
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<DeleteSuccessResponse | DeleteErrorResponse | { error: string }>
) {
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', ['DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { filename, public_id } = req.query;
    const tenantId = req.headers['x-tenant-id'] as string;
    const userId = req.headers['x-user-id'] as string;

    if (!tenantId) res.status(400).json(new ApiError(400, 'Tenant Id is required'));

    if (!userId) res.status(400).json(new ApiError(400, 'User Id is required'));

    if (!public_id) res.status(400).json(new ApiError(400, 'public_id is required'));

    const validateFile = await prisma.upload.findFirst({
      where: {
        tenantId: tenantId,
        userId: userId,
        ...(filename ? { localPath: `public/temp/${filename}` } : {}),
        ...(public_id ? { publicId: public_id as string } : {}),
      },
    });
    if (!validateFile) {
      return res.status(404).json(new ApiError(404, 'File not found or access denied'));
    }

    const { result } = await cloudinary.uploader.destroy(public_id as string);

    // 1. Try deleting from local temp
    if (filename) {
      const filePath = path.join(TEMP_UPLOAD_DIR, filename as string);
      try {
        if (filePath) await fs.unlink(filePath);
        const local = ApiSuccess.ok('File deleted from local', {
          deletedFrom: 'local',
        });
        return res.status(200).json({
          ...local,
          deletedFrom: 'local',
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('Local Deletion Error:', err);
          return res.status(500).json({ error: 'Local file deletion failed. Try again.' });
        }
        // If file doesn't exist locally, proceed to check Cloudinary
        return res
          .status((err as any).status)
          .json(new ApiError((err as any).status, (err as any).message));
      }
    }

    if (result != 'ok') {
      return res.status(404).json({
        error: `File not found on Cloudinary (public_id: ${public_id})`,
      });
    }

    const cld = ApiSuccess.ok('File deleted from Cloudinary', {
      deletedFrom: 'cloudinary',
    });
    return res.status(cld.statusCode).json({
      ...cld,
      deletedFrom: 'cloudinary',
    });
  } catch (err) {
    console.error('Delete Error:', err);
    return res.status(500).json({ error: 'File deletion failed. Try again.' });
  }
}
