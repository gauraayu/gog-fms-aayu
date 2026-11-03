import mongoose from "mongoose";
import dns from "node:dns";

/**
 * Cached MongoDB connection — same pattern as OMS src/lib/mongodb.ts,
 * deliberately WITHOUT OMS's onDbConnected() (FMS never creates/alters
 * indexes on OMS collections).
 *
 * DNS: like OMS, use public resolvers (1.1.1.1, 8.8.8.8) so `mongodb+srv://`
 * SRV lookups work on ISP/router DNS that refuses them (querySrv ECONNREFUSED).
 * Override with FMS_DNS_SERVERS="a,b" or disable with FMS_DNS_SERVERS=off.
 */
function applyDnsServers() {
  const cfg = (process.env.FMS_DNS_SERVERS ?? "1.1.1.1,8.8.8.8").trim();
  if (!cfg || cfg.toLowerCase() === "off") return;
  const servers = cfg.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    dns.setServers(servers);
    dns.promises.setServers(servers);
  } catch (e) {
    console.warn("[FMS] Could not set DNS servers:", (e as Error).message);
  }
}
let dnsApplied = false;
type Cache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null; uri: string | null };
const g = globalThis as unknown as { __fmsMongoose?: Cache };
const cache: Cache = g.__fmsMongoose ?? (g.__fmsMongoose = { conn: null, promise: null, uri: null });

export async function connectDB(): Promise<typeof mongoose> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    const e = new Error("Database not connected yet (MONGODB_URI is not set)");
    e.name = "DbNotConfigured";
    throw e;
  }

  if (cache.conn && cache.uri === uri && mongoose.connection.readyState === 1) return cache.conn;
  if (cache.uri !== uri) {
    cache.promise = null;
    cache.conn = null;
  }
  if (!cache.promise) {
    if (!dnsApplied) {
      applyDnsServers();
      dnsApplied = true;
    }
    cache.uri = uri;
    cache.promise = mongoose.connect(uri, {
      bufferCommands: false,
      serverSelectionTimeoutMS: 5000,
      heartbeatFrequencyMS: 10000,
      maxPoolSize: 20,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      autoIndex: true, // only FMS models enable indexes; OMS read-only models set autoIndex:false
    });
  }
  try {
    cache.conn = await cache.promise;
  } catch (e) {
    cache.promise = null;
    throw e;
  }
  return cache.conn;
}