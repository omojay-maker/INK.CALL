import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8090),
  HOST: z.string().default("0.0.0.0"),
  APP_ORIGIN: z.string().min(1),
  CALL_JWT_SECRET: z.string().min(32),
  CALL_JWT_ISSUER: z.string().default("ink-web"),
  CALL_JWT_AUDIENCE: z.string().default("ink-call-service"),
  DB_HOST: z.string(),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_NAME: z.string(),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
  REDIS_URL: z.string().optional(),
  STUN_URL: z.string().default("stun:stun.l.google.com:19302"),
  TURN_URL: z.string().optional(),
  TURN_TLS_URL: z.string().optional(),
  TURN_SHARED_SECRET: z.string().optional(),
  TURN_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(3600),
  ADMIN_SERVICE_SECRET: z.string().min(32)
});

export const config = schema.parse(process.env);
