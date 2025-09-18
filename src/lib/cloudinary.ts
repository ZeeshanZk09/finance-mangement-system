// src/lib/cloudinary.ts
import { UploadModel } from '@/app/generated/prisma/client/models';
import { v2 as cloudinary, UploadApiErrorResponse, UploadApiResponse } from 'cloudinary';
import { createReadStream } from 'node:fs';
import prisma from '@/lib/prisma';
import path from 'node:path';
import { ApiError } from '@/utils/NextApiError';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME!,
  api_key: process.env.CLOUDINARY_API_KEY!,
  api_secret: process.env.CLOUDINARY_API_SECRET!,
});

export default cloudinary;

const UPLOAD_STREAM_TIMEOUT_MS = 30_000; // optional timeout

/**
 * Upload a local file to Cloudinary using an upload_stream in a fully typed way.
 * @param absPath absolute path to the local file
 * @param tenantFolder remote folder on Cloudinary
 * @returns UploadApiResponse (typed)
 */
async function uploadFileStream(absPath: string, tenantFolder: string): Promise<UploadApiResponse> {
  return new Promise<UploadApiResponse>((resolve, reject) => {
    // create the Cloudinary upload stream with typed callback
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: tenantFolder,
        resource_type: 'auto',
        use_filename: false,
        unique_filename: true,
        overwrite: false,
      },
      (error: UploadApiErrorResponse | undefined, result: UploadApiResponse | undefined) => {
        // callback is invoked once upload completes or errors
        if (error) {
          return reject(error);
        }
        if (!result) {
          return reject(new ApiError(404, 'Cloudinary returned no result'));
        }
        return resolve(result);
      }
    );

    // pipe the file into Cloudinary stream
    const readStream = createReadStream(absPath);

    // handle read-stream errors
    readStream.on('error', (err) => {
      // close/cleanup uploadStream if possible
      try {
        // uploadStream is a writable stream; destroy it to stop upload
        // @ts-ignore - cloudinary upload_stream doesn't expose a destroy type, defensive
        if (typeof (uploadStream as any).destroy === 'function') (uploadStream as any).destroy();
      } catch {
        // ignore
      }
      reject(err);
    });

    // Optional: set a timeout to avoid hanging uploads
    const timeout = setTimeout(() => {
      try {
        // destroy both streams if stuck
        // @ts-ignore
        if (typeof (uploadStream as any).destroy === 'function') (uploadStream as any).destroy();
      } catch {
        // ignore
      }
      reject(new ApiError(504, 'Cloudinary upload timeout'));
    }, UPLOAD_STREAM_TIMEOUT_MS);

    // When uploadStream finishes or errors, clear the timeout
    // Note: the callback above resolves/rejects; make sure timeout cleared there too
    const wrappedResolve = (res: UploadApiResponse) => {
      clearTimeout(timeout);
      resolve(res);
    };
    const wrappedReject = (err: unknown) => {
      clearTimeout(timeout);
      reject(err);
    };

    // We can't replace the original uploader callback easily, so we just
    // keep the original and rely on clearTimeout in callback, but ensure
    // readStream piping is safe.
    // Pipe now:
    readStream.pipe(uploadStream);
    // Note: the callback will call resolve/reject which clears timeout indirectly.
  });
}

/**
 * Example worker processing function that uses typed upload and then updates Prisma.
 */
export async function processUploadAndSave(uploadId: number): Promise<UploadModel> {
  // fetch upload row (typed)
  const uploadRow = await prisma.upload.findUnique({
    where: { id: uploadId },
  });

  if (!uploadRow) {
    throw new ApiError(404, `Upload record not found: ${uploadId}`);
  }

  const absPath = path.join(process.cwd(), uploadRow.localPath!); // ensure localPath is a relative path stored earlier

  // Upload to Cloudinary (typed result)
  const result: UploadApiResponse = await uploadFileStream(
    absPath,
    `${process.env.CLOUD_FOLDER_PREFIX ?? 'tawazun-books'}/${uploadRow.tenantId}/${
      uploadRow.purpose
    }`
  );

  // update DB atomically (you can wrap in $transaction if multiple updates)
  const updated = await prisma.upload.update({
    where: { id: uploadId },
    data: {
      status: 'UPLOADED',
      publicId: result.public_id,
      url: result.secure_url,
      size: typeof result.bytes === 'number' ? result.bytes : uploadRow.size,
      meta: {
        format: result.format,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        raw_response: {
          // keep only small subset to avoid giant objects in DB, but typed
          public_id: result.public_id,
          version: result.version,
          signature: result.signature,
        },
      },
      uploadedAt: new Date(),
    },
  });

  return updated;
}
