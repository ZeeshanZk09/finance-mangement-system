import { Prisma } from '@/app/generated/prisma/client/client';
import pino from 'pino';
import { ApiError } from '../NextApiError';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * Centralized Prisma error handler for production.
 * Converts Prisma errors to ApiError with safe messages.
 * Logs details internally, returns clean messages to client.
 */

function prismaErrorHandler(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // Error codes: https://www.prisma.io/docs/reference/api-reference/error-reference
    switch (err.code) {
      case 'P2002': // Unique constraint failed
        throw new ApiError(409, `Duplicate value for field(s): ${err.meta?.target ?? 'unknown'}`);

      case 'P2003': // Foreign key constraint
        throw new ApiError(409, `Invalid reference: ${err.meta?.field_name ?? 'related record'}`);

      case 'P2025': // Record not found
        throw new ApiError(404, 'Record not found or already deleted');

      default:
        logger.error({ err }, 'Prisma known request error');
        throw new ApiError(400, 'Invalid database operation');
    }
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    logger.warn({ err }, 'Prisma validation error');
    throw new ApiError(400, 'Invalid input data');
  }

  if (err instanceof Prisma.PrismaClientInitializationError) {
    logger.fatal({ err }, 'Prisma initialization error');
    throw new ApiError(500, 'Database unavailable');
  }

  if (err instanceof Prisma.PrismaClientRustPanicError) {
    logger.fatal({ err }, 'Prisma Rust panic');
    throw new ApiError(500, 'Critical database error');
  }

  // Fallback: log everything else but respond with safe message
  logger.error({ err }, 'Unhandled Prisma error');
  throw new ApiError(500, 'Unexpected database error');
}

export { prismaErrorHandler };
