import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import pinoHttp from 'pino-http';
import { z } from 'zod';

import { config } from './config.js';
import { db, log } from './db.js';
import { AdbService, RemoteKey } from './adb.js';

const app = express();
const adb = new AdbService();

app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGINS.split(',').map((x) => x.trim()) }));
app.use(express.json({ limit: '20kb' }));
app.use(pinoHttp());

app.get('/health', (_q, r) => r.json({ status: 'ok', time: new Date().toISOString() }));

app.post('/api/auth/login', (q, r) => {
  const p = z.object({ password: z.string() }).safeParse(q.body);
  if (!p.success || p.data.password !== config.ADMIN_PASSWORD) {
    return r.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }
  return r.json({ token: jwt.sign({ role: 'admin' }, config.JWT_SECRET, { expiresIn: '12h' }) });
});

app.use('/api', (q, r, n) => {
  const token = q.headers.authorization?.replace(/^Bearer /, '');
  try {
    jwt.verify(token ?? '', config.JWT_SECRET);
    n();
  } catch {
    return r.status(401).json({ error: 'UNAUTHORIZED' });
  }
});

app.get('/api/device/status', async (_q, r) => r.json(await adb.status()));

app.get('/api/device/foreground', async (_q, r, n) => {
  try {
    r.json(await adb.foreground());
  } catch (e) {
    n(e);
  }
});

app.get('/api/device/screenshot', async (_q, r, n) => {
  try {
    r.type('png').send(await adb.screenshot());
  } catch (e) {
    n(e);
  }
});

app.post('/api/device/key', async (q, r, n) => {
  try {
    const { key } = z
      .object({ key: z.enum(['HOME', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK']) })
      .parse(q.body);
    const out = await adb.key(key as RemoteKey);
    log(`key:${key}`, 'success');
    r.json(out);
  } catch (e) {
    n(e);
  }
});

app.post('/api/device/text', async (q, r, n) => {
  try {
    const { text } = z.object({ text: z.string().min(1).max(120) }).parse(q.body);
    await adb.text(text);
    log('text', 'success');
    r.json({ ok: true });
  } catch (e) {
    n(e);
  }
});

app.get('/api/logs', (_q, r) =>
  r.json(db.prepare('SELECT * FROM execution_logs ORDER BY id DESC LIMIT 100').all())
);

app.use((e: unknown, _q: express.Request, r: express.Response, _n: express.NextFunction) => {
  const message = e instanceof Error ? e.message : 'Unknown error';
  log('request', 'error', message);
  r.status(400).json({ error: 'REQUEST_FAILED', message });
});

app.listen(config.PORT, config.HOST, () => console.log(`API on ${config.HOST}:${config.PORT}`));
