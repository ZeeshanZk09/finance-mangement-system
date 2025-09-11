import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Create a single ioredis connection for producer
const connection = new IORedis(REDIS_URL);

// Main queue used by API (producer) to add jobs
export const uploadQueue = new Queue(process.env.UPLOAD_QUEUE_NAME!, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: { age: 60 * 60 * 24 }, // keep metadata a day (seconds)
    removeOnFail: { age: 60 * 60 * 24 * 7 }, // keep failed for 7 days
  },
});

// Optional: QueueEvents for monitoring (you can import/use it)
export const uploadQueueEvents = new QueueEvents(process.env.UPLOAD_QUEUE_NAME!, { connection });

// Graceful shutdown helper (call from process hooks if needed)
export async function closeQueues() {
  try {
    await uploadQueue.close();
    await uploadQueueEvents.close();
    await connection.quit();
  } catch (err) {
    // ignore
    console.warn('Error closing queues', err);
  }
}

// Export a small helper to add jobs with typing
export async function enqueueUploadJob(payload: { uploadId: string }, opts?: any) {
  // opts can override job options per job
  return uploadQueue.add('upload-to-cloud', payload, opts);
}
