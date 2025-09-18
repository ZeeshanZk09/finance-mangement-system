// src/lib/redis.ts
/**
 * Production-ready Redis connection helper using ioredis.
 *
 * Supports:
 *  - Standalone (REDIS_URL)
 *  - Cluster (REDIS_CLUSTER_NODES as JSON array or comma-separated host:port list)
 *  - Sentinel (REDIS_SENTINEL_NODES + REDIS_SENTINEL_MASTER_NAME)
 *
 * Exports:
 *  - connection: singleton Redis client (Redis or Cluster)
 *  - getConnection(): accessor
 *  - ready(): Promise<void> that resolves once the client is ready
 *  - ping(): health check (returns pong or throws)
 *  - close(): graceful shutdown
 *
 * Env variables used (common):
 *  REDIS_URL
 *  REDIS_CLUSTER_NODES (json array or comma separated "host:port")
 *  REDIS_SENTINEL_NODES (json array or comma separated "host:port")
 *  REDIS_SENTINEL_MASTER_NAME
 *  REDIS_TLS (true/1 => enable tls option)
 *  REDIS_PASSWORD
 *  REDIS_PREFIX (optional key prefix)
 *  REDIS_MAX_RETRIES (optional)
 *  APP_NAME, NODE_ENV for connection name
 */

import IORedis, { RedisOptions, ClusterNode, ClusterOptions, Redis, Cluster } from 'ioredis';
import os from 'os';

interface SimpleLogger {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
}

const logger: SimpleLogger = (() => {
  try {
    // prefer pino if your app uses it - keep import lazy to avoid forcing dependency
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pino = require('pino') as typeof import('pino');
    return pino({ name: process.env.APP_NAME ?? 'app', level: process.env.LOG_LEVEL ?? 'info' });
  } catch {
    // fallback
    // eslint-disable-next-line no-console
    return {
      info: (...a: any[]) => console.log(...a),
      warn: (...a: any[]) => console.warn(...a),
      error: (...a: any[]) => console.error(...a),
      debug: (...a: any[]) => console.debug(...a),
    } as const;
  }
})();

/** Types */
export type RedisClient = Redis | Cluster;

/** env helpers */
const ENV = process.env.NODE_ENV ?? 'development';
const APP_NAME = process.env.APP_NAME ?? 'finapp';
const HOSTNAME = os.hostname()?.split('.')[0] ?? 'local';
const REDIS_URL = process.env.REDIS_URL;
const REDIS_CLUSTER_NODES = process.env.REDIS_CLUSTER_NODES; // JSON '[{"host":"...","port":6379}, ...]' or 'h1:6379,h2:6379'
const REDIS_SENTINEL_NODES = process.env.REDIS_SENTINEL_NODES; // same format as cluster nodes
const REDIS_SENTINEL_MASTER_NAME = process.env.REDIS_SENTINEL_MASTER_NAME;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD ?? process.env.REDIS_AUTH;
const REDIS_TLS = process.env.REDIS_TLS === 'true' || process.env.REDIS_TLS === '1';
const REDIS_PREFIX = process.env.REDIS_PREFIX ?? `${APP_NAME}:${ENV}:`;
const REDIS_MAX_RETRIES = Number(process.env.REDIS_MAX_RETRIES ?? 5);

/** Retry/backoff strategy for standalone client */
function retryStrategy(times: number): number | void {
  // exponential backoff with cap
  const delay = Math.min(50 * Math.pow(2, times), 2000);
  return delay;
}

/** Convert comma-separated host:port or JSON array to cluster nodes */
function parseNodes(input?: string): ClusterNode[] | null {
  if (!input) return null;
  try {
    // try JSON parse first
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed) && parsed.every((n) => n.host && n.port)) {
      return parsed.map((n: any) => ({ host: String(n.host), port: Number(n.port) }));
    }
  } catch {
    // not JSON - fallback to comma separated
  }
  const parts = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts
    .map((p) => {
      const [host, port] = p.split(':').map((x) => x.trim());
      if (!host) return null;
      return { host, port: port ? Number(port) : 6379 };
    })
    .filter(Boolean) as ClusterNode[];
}

/** Create connection name */
function makeConnName(): string {
  return `${APP_NAME}-${ENV}-${HOSTNAME}-${process.pid}`;
}

/** Build options for standalone client */
function buildStandaloneOptions(): RedisOptions {
  const opt: RedisOptions = {
    // connectionName available in ioredis v4
    connectionName: makeConnName(),
    maxRetriesPerRequest: REDIS_MAX_RETRIES,
    retryStrategy,
    // useful for BullMQ: disable offline queue if you want to fail fast
    // enableReadyCheck: true,
    // show friendly key prefix
    keyPrefix: REDIS_PREFIX,
    // lazyConnect allows explicit .connect() later
    lazyConnect: false,
  };

  if (REDIS_PASSWORD) opt.password = REDIS_PASSWORD;
  if (REDIS_TLS) {
    opt.tls = {}; // use default TLS; for custom CA add `ca` buffer
  }

  return opt;
}

/** Build cluster options */
function buildClusterOptions(): ClusterOptions {
  const opt: ClusterOptions = {
    redisOptions: buildStandaloneOptions(),
  };
  return opt;
}

/** Build sentinel options (for ioredis sentinel) */
function buildSentinelOptions(sentinels: ClusterNode[], name: string): RedisOptions {
  const opt = buildStandaloneOptions();
  // ioredis sentinel expects 'sentinels' + 'name' fields: new Redis({ sentinels: [{ host, port }], name: 'mymaster' })
  // we'll copy sentinel nodes in the connect call
  return opt;
}

/** Singleton holders in globalThis to survive HMR / serverless reloads */
declare global {
  // eslint-disable-next-line no-var
  var __REDIS_CLIENT__: RedisClient | undefined;
  // eslint-disable-next-line no-var
  var __REDIS_READY_PROMISE__: Promise<void> | undefined;
}

function createStandaloneClient(): Redis {
  const opts = buildStandaloneOptions();
  logger.info;
  // ({ opts: { maxRetriesPerRequest: opts.maxRetriesPerRequest, keyPrefix: opts.keyPrefix } }, 'creating standalone redis client');
  const client = new IORedis(REDIS_URL!, opts);
  attachEventHandlers(client);
  return client;
}

function createClusterClient(nodes: ClusterNode[]): Cluster {
  const opts = buildClusterOptions();
  logger.info({ nodes, note: 'creating cluster redis client' });
  const client = new IORedis.Cluster(nodes, opts);
  attachEventHandlers(client);
  return client;
}

function createSentinelClient(sentinels: ClusterNode[], name: string): Redis {
  const opts = buildSentinelOptions(sentinels, name);
  logger.info({ sentinels, name, note: 'creating sentinel redis client' });
  // @ts-ignore ioredis sentinel constructor expects options with sentinels + name
  const client = new IORedis({ sentinels, name, ...opts } as any);
  attachEventHandlers(client);
  return client;
}

/** Attach event handlers to any client (Redis or Cluster) */
function attachEventHandlers(client: RedisClient) {
  // ioredis Cluster and Redis both emit these events
  client.on('connect', () => logger.info('redis: connect'));
  client.on('ready', () => logger.info('redis: ready'));
  client.on('error', (err: Error) => logger.error({ err }, 'redis: error'));
  client.on('close', () => logger.warn('redis: close'));
  client.on('reconnecting', () => logger.warn('redis: reconnecting'));
  client.on('end', () => logger.warn('redis: end'));
}

/** Create or return singleton connection */
function initConnection(): RedisClient {
  if (global.__REDIS_CLIENT__) {
    return global.__REDIS_CLIENT__;
  }

  // Cluster precedence
  const clusterNodes = parseNodes(REDIS_CLUSTER_NODES);
  if (clusterNodes && clusterNodes.length > 0) {
    global.__REDIS_CLIENT__ = createClusterClient(clusterNodes);
    return global.__REDIS_CLIENT__;
  }

  // Sentinel precedence
  const sentinelNodes = parseNodes(REDIS_SENTINEL_NODES);
  if (sentinelNodes && sentinelNodes.length > 0 && REDIS_SENTINEL_MASTER_NAME) {
    global.__REDIS_CLIENT__ = createSentinelClient(sentinelNodes, REDIS_SENTINEL_MASTER_NAME);
    return global.__REDIS_CLIENT__;
  }

  // Standalone fallback
  if (!REDIS_URL) {
    logger.warn(
      'No REDIS_URL, REDIS_CLUSTER_NODES or REDIS_SENTINEL_NODES provided — connecting to localhost:6379'
    );
  }
  global.__REDIS_CLIENT__ = createStandaloneClient();
  return global.__REDIS_CLIENT__;
}

const connection = initConnection();

/** ready promise resolves when client is ready (or cluster is ready) */
if (!global.__REDIS_READY_PROMISE__) {
  global.__REDIS_READY_PROMISE__ = new Promise((resolve) => {
    // If already ready, resolve immediately
    // For cluster, 'ready' may emit later for each node; rely on one ready event
    const onReady = () => {
      logger.info('redis: ready (global promise resolved)');
      resolve();
    };
    // If connection is already ready, resolve now
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if ((connection as any).status === 'ready') {
      onReady();
    } else {
      connection.once('ready', onReady);
      // safety: set timeout to resolve after a while so callers don't hang indefinitely
      const timeoutMs = Number(process.env.REDIS_READY_TIMEOUT_MS ?? 10000);
      setTimeout(() => {
        logger.warn('redis: ready timeout reached, resolving ready promise anyway');
        resolve();
      }, timeoutMs).unref();
    }
  });
}

/** Accessor helpers */
async function ready(): Promise<void> {
  return global.__REDIS_READY_PROMISE__!;
}

async function ping(): Promise<string> {
  await ready();
  // @ts-ignore - both clients expose .ping()
  const res = await (connection as any).ping();
  return String(res);
}

async function close(): Promise<void> {
  try {
    logger.info('redis: closing connection...');
    // cluster and standalone have different close methods, using .quit() is safe
    // @ts-ignore
    if (connection && typeof (connection as any).quit === 'function') {
      await (connection as any).quit();
    } else if (connection && typeof (connection as any).disconnect === 'function') {
      (connection as any).disconnect();
    }
    // clear singleton
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    global.__REDIS_CLIENT__ = undefined;
    logger.info('redis: closed');
  } catch (err) {
    logger.warn({ err }, 'redis: error during close');
  }
}

/** Export */
const getConnection = (): RedisClient => connection;
export { connection, getConnection, ready, ping, close };
export default connection;
