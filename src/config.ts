import 'dotenv/config';
import { z } from 'zod';

const flag = z.enum(['true', 'false']).transform(v => v === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PAYMENT_PROVIDER: z.enum(['demo', 'tbc']).default('demo'),
  EMAIL_TRANSPORT: z.enum(['preview', 'smtp']).default('preview'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  APP_URL: z.url().default('http://localhost:3000'),
  DB_PATH: z.string().default('./data/bookings.sqlite'),
  OWNER_EMAIL: z.email().default('owner@example.com'),
  MAIL_FROM: z.string().min(3).regex(/^[^\r\n]+$/).default('Tour Bookings <bookings@example.com>'),
  TBC_PAYMENTS_ENABLED: flag.default(false),
  TBC_API_KEY: z.string().default(''),
  TBC_CLIENT_ID: z.string().default(''),
  TBC_CLIENT_SECRET: z.string().default(''),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: flag.default(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0)
});

export type Config = z.infer<typeof schema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid settings: ${result.error.issues.map(i => i.path.join('.')).join(', ')}`);
  const cfg = result.data;
  const url = new URL(cfg.APP_URL);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('APP_URL must be a plain http(s) origin, without credentials, path, query or fragment.');
  }
  cfg.APP_URL = url.origin;
  if (cfg.PAYMENT_PROVIDER === 'tbc') {
    if (!cfg.TBC_PAYMENTS_ENABLED || !cfg.TBC_API_KEY || !cfg.TBC_CLIENT_ID || !cfg.TBC_CLIENT_SECRET || url.protocol !== 'https:') {
      throw new Error('TBC requires explicit TBC_PAYMENTS_ENABLED=true, three merchant credentials and a public HTTPS APP_URL.');
    }
  }
  if (cfg.EMAIL_TRANSPORT === 'smtp') {
    if (!cfg.SMTP_HOST || !cfg.SMTP_USER || !cfg.SMTP_PASS || cfg.OWNER_EMAIL.endsWith('@example.com') || cfg.MAIL_FROM.includes('@example.com')) {
      throw new Error('SMTP requires real mail credentials, OWNER_EMAIL and MAIL_FROM.');
    }
  }
  if (cfg.NODE_ENV === 'production' && (cfg.PAYMENT_PROVIDER !== 'tbc' || cfg.EMAIL_TRANSPORT !== 'smtp')) {
    throw new Error('Production requires TBC payments and SMTP; demo endpoints must not be published as a live service.');
  }
  return cfg;
}
