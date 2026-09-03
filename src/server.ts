import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import pinoHttp from 'pino-http';
import { z } from 'zod';

import { AdbService, keyCodes, RemoteKey } from './adb.js';
import { config } from './config.js';
import { db, log } from './db.js';

const app = express();

const id = z.string().min(2).max(100).transform((value, context) => {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (normalized.length < 2 || normalized.length > 63) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Use um identificador entre 2 e 63 caracteres.' });
    return z.NEVER;
  }
  return normalized;
});
const enabled = z.boolean().default(true);
const keyEnum = z.enum(Object.keys(keyCodes) as [RemoteKey, ...RemoteKey[]]);

const stepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('key'), key: keyEnum }),
  z.object({ type: z.literal('text'), value: z.string().min(1).max(120) }),
  z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(100).max(30_000) }),
  z.object({ type: z.literal('openApp'), packageName: z.string().min(1).max(200) }),
]);

const schemas = {
  devices: z.object({
    id,
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(5555),
    enabled,
  }),
  apps: z.object({ id, name: z.string().min(1), packageName: z.string().min(1), enabled }),
  macros: z.object({
    id,
    name: z.string().min(1),
    description: z.string().default(''),
    steps: z.array(stepSchema).min(1),
    enabled,
  }),
  intents: z.object({
    id,
    name: z.string().min(1),
    macroId: id,
    phrases: z.array(z.string().min(1)).min(1),
    enabled,
  }),
  automations: z.object({
    id,
    name: z.string().min(1),
    deviceId: id,
    macroId: id,
    schedule: z.string().min(1),
    enabled,
  }),
  commands: z.object({
    id,
    label: z.string().min(1).max(80),
    aliases: z.array(z.string().min(1).max(64)).min(1),
    keys: z.array(keyEnum).min(1),
    enabled,
  }),
};
const commandSeeds: { id: string; label: string; aliases: string[]; keys: RemoteKey[] }[] = [
  { id: 'up', label: 'Seta para cima', aliases: ['cima', 'pra cima', 'seta pra cima', 'sobe'], keys: ['DPAD_UP'] },
  { id: 'down', label: 'Seta para baixo', aliases: ['baixo', 'pra baixo', 'seta pra baixo', 'desce'], keys: ['DPAD_DOWN'] },
  { id: 'left', label: 'Seta para esquerda', aliases: ['esquerda', 'pra esquerda'], keys: ['DPAD_LEFT'] },
  { id: 'right', label: 'Seta para direita', aliases: ['direita', 'pra direita'], keys: ['DPAD_RIGHT'] },
  { id: 'ok', label: 'OK / Enter', aliases: ['ok', 'enter', 'confirmar', 'abrir'], keys: ['ENTER'] },
  { id: 'back', label: 'Voltar', aliases: ['voltar', 'volta', 'retornar'], keys: ['BACK'] },
  { id: 'home', label: 'Início (Home)', aliases: ['home', 'inicio', 'início'], keys: ['HOME'] },
  { id: 'play-pause', label: 'Reproduzir/Pausar', aliases: ['play', 'pausa', 'toca', 'pausar'], keys: ['PLAY_PAUSE'] },
  { id: 'mute', label: 'Silenciar', aliases: ['mudo', 'mutar', 'mute', 'silencia'], keys: ['MUTE'] },
  { id: 'volume-up', label: 'Aumentar volume', aliases: ['volume mais', 'aumenta volume', 'vol +'], keys: ['VOLUME_UP'] },
  { id: 'volume-down', label: 'Diminuir volume', aliases: ['volume menos', 'diminui volume', 'vol -'], keys: ['VOLUME_DOWN'] },
];

function seedCommands() {
  const row = db.prepare('SELECT COUNT(*) AS total FROM commands').get() as { total: number };
  if (row.total > 0) return;
  const insert = db.prepare(
    'INSERT INTO commands(id,label,aliases_json,keys_json,enabled) VALUES(?,?,?,?,1)',
  );
  for (const command of commandSeeds) {
    insert.run(
      command.id,
      command.label,
      JSON.stringify(command.aliases),
      JSON.stringify(command.keys),
    );
  }
}
seedCommands();

const allowedOrigins = config.CORS_ORIGINS.split(',').map((origin) => origin.trim());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

app.use(helmet());
app.use(cors({ origin: allowedOrigins.includes('*') ? true : allowedOrigins }));
app.use(express.json({ limit: '50kb' }));
app.use(pinoHttp());

app.use(
  '/api/v1',
  rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }),
);

app.get('/health', (_request, response) =>
  response.json({ status: 'ok', time: new Date().toISOString() }),
);

app.get('/api/v1/health', (_request, response) =>
  response.json({ status: 'ok', time: new Date().toISOString() }),
);

app.post('/api/v1/auth/login', authLimiter, (request, response) => {
  const input = z.object({ password: z.string() }).safeParse(request.body);
  if (!input.success || input.data.password !== config.ADMIN_PASSWORD) {
    return response.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }
  return response.json({
    token: jwt.sign({ role: 'admin' }, config.JWT_SECRET),
  });
});

app.use('/api', (request, response, next) => {
  try {
    jwt.verify(request.headers.authorization?.replace(/^Bearer /, '') ?? '', config.JWT_SECRET);
    next();
  } catch {
    response.status(401).json({ error: 'UNAUTHORIZED' });
  }
});

app.get('/api/v1/actions', (_request, response) =>
  response.json([
    { type: 'key', key: 'HOME', label: 'Início' },
    { type: 'key', key: 'BACK', label: 'Voltar' },
    { type: 'key', key: 'DPAD_UP', label: 'Seta para cima' },
    { type: 'key', key: 'DPAD_DOWN', label: 'Seta para baixo' },
    { type: 'key', key: 'DPAD_LEFT', label: 'Seta para esquerda' },
    { type: 'key', key: 'DPAD_RIGHT', label: 'Seta para direita' },
    { type: 'key', key: 'ENTER', label: 'Botão OK' },
    { type: 'key', key: 'PLAY_PAUSE', label: 'Reproduzir/Pausar' },
    { type: 'key', key: 'VOLUME_UP', label: 'Aumentar volume' },
    { type: 'key', key: 'VOLUME_DOWN', label: 'Diminuir volume' },
    { type: 'key', key: 'MUTE', label: 'Silenciar' },
    { type: 'text', label: 'Digitar texto' },
    { type: 'wait', label: 'Aguardar' },
    { type: 'openApp', label: 'Abrir aplicativo' },
  ]),
);
type Resource = keyof typeof schemas;
const resources: Resource[] = ['devices', 'apps', 'macros', 'intents', 'automations', 'commands'];

const columns: Record<Resource, Record<string, string>> = {
  devices: { name: 'name', host: 'host', port: 'port', enabled: 'enabled' },
  apps: { name: 'name', packageName: 'package_name', enabled: 'enabled' },
  macros: { name: 'name', description: 'description', steps: 'steps_json', enabled: 'enabled' },
  intents: { name: 'name', macroId: 'macro_id', phrases: 'phrases_json', enabled: 'enabled' },
  automations: {
    name: 'name',
    deviceId: 'device_id',
    macroId: 'macro_id',
    schedule: 'schedule',
    enabled: 'enabled',
  },
  commands: { label: 'label', aliases: 'aliases_json', keys: 'keys_json', enabled: 'enabled' },
};

const arrayColumns = new Set(['steps', 'phrases', 'aliases', 'keys']);

function serialize(resource: Resource, value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(columns[resource]).map(([property, column]) => {
      const raw = value[property];
      return [
        column,
        Array.isArray(raw) ? JSON.stringify(raw) : typeof raw === 'boolean' ? Number(raw) : raw,
      ];
    }),
  );
}

function deserialize(resource: Resource, row: Record<string, unknown>) {
  const output: Record<string, unknown> = { id: row['id'] };
  for (const [property, column] of Object.entries(columns[resource])) {
    const raw = row[column];
    output[property] =
      property === 'enabled'
        ? Boolean(raw)
        : arrayColumns.has(property)
          ? JSON.parse(String(raw))
          : raw;
  }
  return output;
}

for (const resource of resources) {
  const orderBy = resource === 'commands' ? 'label' : 'name';

  app.get(`/api/v1/${resource}`, (_request, response) => {
    const rows = db
      .prepare(`SELECT * FROM ${resource} ORDER BY ${orderBy}`)
      .all() as Record<string, unknown>[];
    response.json(rows.map((row) => deserialize(resource, row)));
  });

  app.post(`/api/v1/${resource}`, (request, response, next) => {
    try {
      const value = schemas[resource].parse(request.body) as Record<string, unknown>;
      const stored = serialize(resource, value);
      const names = ['id', ...Object.keys(stored)];
      db.prepare(
        `INSERT INTO ${resource} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      ).run(value['id'], ...Object.values(stored));
      response.status(201).json(value);
    } catch (error) {
      next(error);
    }
  });

  app.put(`/api/v1/${resource}/:id`, (request, response, next) => {
    try {
      const value = schemas[resource].parse({
        ...request.body,
        id: request.params['id'],
      }) as Record<string, unknown>;
      const stored = serialize(resource, value);
      const result = db
        .prepare(
          `UPDATE ${resource} SET ${Object.keys(stored)
            .map((name) => `${name}=?`)
            .join(',')} WHERE id=?`,
        )
        .run(...Object.values(stored), value['id']);
      result.changes ? response.json(value) : response.status(404).json({ error: 'NOT_FOUND' });
    } catch (error) {
      next(error);
    }
  });

  app.delete(`/api/v1/${resource}/:id`, (request, response) => {
    const result = db.prepare(`DELETE FROM ${resource} WHERE id=?`).run(request.params['id']);
    result.changes
      ? response.status(204).send()
      : response.status(404).json({ error: 'NOT_FOUND' });
  });
}
function getDevice(deviceId: string) {
  const row = db
    .prepare('SELECT host, port FROM devices WHERE id=? AND enabled=1')
    .get(deviceId) as { host: string; port: number } | undefined;
  return row ? new AdbService(row.host, row.port) : null;
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

async function executeMacro(
  deviceId: string,
  macroId: string,
  variables: Record<string, string> = {},
) {
  const adb = getDevice(deviceId);
  if (!adb) throw new Error('DEVICE_NOT_FOUND');

  const row = db
    .prepare('SELECT steps_json FROM macros WHERE id=? AND enabled=1')
    .get(macroId) as { steps_json: string } | undefined;
  if (!row) throw new Error('MACRO_NOT_FOUND');

  const steps = z.array(stepSchema).parse(JSON.parse(row.steps_json));
  for (const step of steps) {
    if (step.type === 'key') await adb.key(step.key);
    if (step.type === 'wait') await new Promise((resolve) => setTimeout(resolve, step.milliseconds));
    if (step.type === 'openApp') await adb.openApp(step.packageName);
    if (step.type === 'text') {
      const text = step.value.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => variables[key] ?? '');
      await adb.text(text);
    }
  }
  log(`macro:${macroId}`, 'success', deviceId);
  return { ok: true, steps: steps.length };
}

app.post('/api/v1/devices/:deviceId/macros/:macroId/run', async (request, response, next) => {
  try {
    response.json(
      await executeMacro(request.params['deviceId'], request.params['macroId'], request.body?.variables),
    );
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/devices/:id/status', async (request, response) => {
  const adb = getDevice(request.params['id']);
  adb ? response.json(await adb.status()) : response.status(404).json({ error: 'DEVICE_NOT_FOUND' });
});

app.post('/api/v1/devices/:id/key', async (request, response, next) => {
  try {
    const adb = getDevice(request.params['id']);
    if (!adb) return response.status(404).json({ error: 'DEVICE_NOT_FOUND' });
    const key = keyEnum.parse(request.body?.key);
    await adb.key(key);
    log(`key:${key}`, 'success', request.params['id']);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/devices/:id/text', async (request, response, next) => {
  try {
    const adb = getDevice(request.params['id']);
    if (!adb) return response.status(404).json({ error: 'DEVICE_NOT_FOUND' });
    const text = z.string().min(1).max(120).parse(request.body?.text);
    await adb.text(text);
    log('text', 'success', request.params['id']);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/commands/:commandId/run', async (request, response, next) => {
  try {
    const command = db
      .prepare('SELECT id, label, keys_json FROM commands WHERE id=? AND enabled=1')
      .get(request.params['commandId']) as
      | { id: string; label: string; keys_json: string }
      | undefined;
    if (!command) return response.status(404).json({ error: 'COMMAND_NOT_FOUND' });

    const device = db
      .prepare('SELECT id FROM devices WHERE enabled=1 ORDER BY created_at LIMIT 1')
      .get() as { id: string } | undefined;
    if (!device) return response.status(404).json({ error: 'DEVICE_NOT_FOUND' });

    const adb = getDevice(device.id);
    if (!adb) return response.status(404).json({ error: 'DEVICE_NOT_FOUND' });

    const keys = JSON.parse(command.keys_json) as RemoteKey[];
    for (const key of keys) await adb.key(key);
    log(`command:${command.id}`, 'success', device.id);
    response.json({ ok: true, commandId: command.id, deviceId: device.id, keys });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/commands/resolve', (request, response) => {
  const input = z.object({ text: z.string().min(1).max(120) }).safeParse(request.body);
  if (!input.success) return response.status(400).json({ error: 'INVALID_TEXT' });

  const target = normalizeText(input.data.text);
  const rows = db
    .prepare('SELECT * FROM commands WHERE enabled=1')
    .all() as {
    id: string;
    label: string;
    aliases_json: string;
    keys_json: string;
  }[];

  for (const row of rows) {
    const aliases = JSON.parse(row.aliases_json) as string[];
    const match = aliases.find((alias) => normalizeText(alias) === target);
    if (match) {
      return response.json({
        status: 'MATCHED',
        matchedAlias: match,
        command: { id: row.id, label: row.label, keys: JSON.parse(row.keys_json) },
      });
    }
  }
  response.status(404).json({ status: 'NOT_FOUND' });
});

app.get('/api/v1/logs', (_request, response) =>
  response.json(db.prepare('SELECT * FROM execution_logs ORDER BY id DESC LIMIT 100').all()),
);

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  log('request', 'error', message);
  if (message.startsWith('ADB_UNAUTHORIZED')) {
    return response.status(409).json({ error: 'ADB_UNAUTHORIZED', message });
  }
  if (message.startsWith('ADB_OFFLINE')) {
    return response.status(503).json({ error: 'ADB_OFFLINE', message });
  }
  response.status(400).json({ error: 'REQUEST_FAILED', message });
});

app.listen(config.PORT, config.HOST, () => console.log(`API on ${config.HOST}:${config.PORT}`));
