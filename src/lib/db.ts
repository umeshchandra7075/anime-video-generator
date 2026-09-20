import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

let realClient: PrismaClient | undefined = global.__prisma;

function getClient(): PrismaClient {
  if (!realClient) {
    // Constructed here, on first actual use, rather than at module import
    // time. This matters: if construction throws (the client hasn't been
    // generated yet, DATABASE_URL is malformed, etc.), the error now
    // surfaces inside whichever API route's try/catch is already running -
    // producing our normal structured JSON error response via
    // src/lib/api/response.ts - instead of crashing Next's module loader
    // before any of our error handling ever gets a chance to run.
    realClient = new PrismaClient();
    if (process.env.NODE_ENV !== "production") {
      // Avoid exhausting DB connections with hot-reload in dev.
      global.__prisma = realClient;
    }
  }
  return realClient;
}

export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getClient();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
