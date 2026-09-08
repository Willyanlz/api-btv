import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('127.0.0.1'),
  JWT_SECRET: z.string().min(32),
  ADMIN_PASSWORD: z.string().min(6),
  CORS_ORIGINS: z.string().default('http://localhost:4200'),
  DATABASE_PATH: z.string().default('./data/app.db'),
  MIRROR_HOST: z.string().default('mirror.labswill.com'),
  MIRROR_PUBLIC_URL: z.string().url().default('https://box.labswill.com/mirror/embed.html'),
  MIRROR_TARGET: z.string().url().default('http://127.0.0.1:8000')
});

export const config = schema.parse(process.env);
