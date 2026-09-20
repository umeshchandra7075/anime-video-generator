import IORedis, { Redis } from "ioredis";

let redisSingleton: Redis | undefined;

export function getRedis(): Redis {
  if (!redisSingleton) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("Missing required environment variable: REDIS_URL");
    redisSingleton = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return redisSingleton;
}
