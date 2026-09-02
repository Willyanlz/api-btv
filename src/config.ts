import { z } from 'zod';
const schema=z.object({PORT:z.coerce.number().default(3000),HOST:z.string().default('127.0.0.1'),JWT_SECRET:z.string().min(32),ADMIN_PASSWORD:z.string().min(10),CORS_ORIGINS:z.string().default('http://localhost:4200'),DEVICE_HOST:z.string().default('btv-sogra'),ADB_PORT:z.coerce.number().default(5555),DATABASE_PATH:z.string().default('./data/app.db')});
export const config=schema.parse(process.env);
export const device=`${config.DEVICE_HOST}:${config.ADB_PORT}`;
