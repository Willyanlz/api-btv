import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import pinoHttp from "pino-http";
import { z } from "zod";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdbService, keyCodes, RemoteKey } from "./adb.js";
import { config } from "./config.js";
import { db, log } from "./db.js";

const app = express();

const id = z
  .string()
  .min(2)
  .max(100)
  .transform((value, context) => {
    const normalized = value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (normalized.length < 2 || normalized.length > 63) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Use um identificador entre 2 e 63 caracteres.",
      });
      return z.NEVER;
    }
    return normalized;
  });
const enabled = z.boolean().default(true);
const keyEnum = z.enum(Object.keys(keyCodes) as [RemoteKey, ...RemoteKey[]]);

const stepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("key"), key: keyEnum }),
  z.object({ type: z.literal("text"), value: z.string().min(1).max(120) }),
  z.object({
    type: z.literal("wait"),
    milliseconds: z.number().int().min(100).max(30_000),
  }),
  z.object({
    type: z.literal("openApp"),
    packageName: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("callMacro"),
    macroId: id,
  }),
]);

const schemas = {
  devices: z.object({
    id,
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(5555),
    enabled,
  }),
  macros: z.object({
    id,
    name: z.string().min(1),
    description: z.string().default(""),
    steps: z.array(stepSchema).min(1),
    requiresInput: z.boolean().default(false),
    inputLabel: z.string().min(1).max(100).default("O que deseja buscar?"),
    inputVariable: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
      .default("texto"),
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
const commandSeeds: {
  id: string;
  label: string;
  aliases: string[];
  keys: RemoteKey[];
}[] = [
  {
    id: "up",
    label: "Seta para cima",
    aliases: ["cima", "pra cima", "seta pra cima", "sobe"],
    keys: ["DPAD_UP"],
  },
  {
    id: "down",
    label: "Seta para baixo",
    aliases: ["baixo", "pra baixo", "seta pra baixo", "desce"],
    keys: ["DPAD_DOWN"],
  },
  {
    id: "left",
    label: "Seta para esquerda",
    aliases: ["esquerda", "pra esquerda"],
    keys: ["DPAD_LEFT"],
  },
  {
    id: "right",
    label: "Seta para direita",
    aliases: ["direita", "pra direita"],
    keys: ["DPAD_RIGHT"],
  },
  {
    id: "ok",
    label: "OK / Enter",
    aliases: ["ok", "enter", "confirmar", "abrir"],
    keys: ["ENTER"],
  },
  {
    id: "back",
    label: "Voltar",
    aliases: ["voltar", "volta", "retornar"],
    keys: ["BACK"],
  },
  {
    id: "home",
    label: "Início (Home)",
    aliases: ["home", "inicio", "início"],
    keys: ["HOME"],
  },
  {
    id: "play-pause",
    label: "Reproduzir/Pausar",
    aliases: ["play", "pausa", "toca", "pausar"],
    keys: ["PLAY_PAUSE"],
  },
  {
    id: "mute",
    label: "Silenciar",
    aliases: ["mudo", "mutar", "mute", "silencia"],
    keys: ["MUTE"],
  },
  {
    id: "volume-up",
    label: "Aumentar volume",
    aliases: ["volume mais", "aumenta volume", "vol +"],
    keys: ["VOLUME_UP"],
  },
  {
    id: "volume-down",
    label: "Diminuir volume",
    aliases: ["volume menos", "diminui volume", "vol -"],
    keys: ["VOLUME_DOWN"],
  },
];

function seedCommands() {
  const row = db.prepare("SELECT COUNT(*) AS total FROM commands").get() as {
    total: number;
  };
  if (row.total > 0) return;
  const insert = db.prepare(
    "INSERT INTO commands(id,label,aliases_json,keys_json,enabled) VALUES(?,?,?,?,1)",
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

const allowedOrigins = config.CORS_ORIGINS.split(",").map((origin) =>
  origin.trim(),
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        // blob: é usado pelos screenshots carregados no <img> do controle remoto.
        "img-src": ["'self'", "data:", "blob:"],
      },
    },
  }),
);
app.use(cors({ origin: allowedOrigins.includes("*") ? true : allowedOrigins }));
app.use(
  express.raw({
    type: "application/vnd.android.package-archive",
    limit: "300mb",
  }),
);
app.use(express.json({ limit: "50kb" }));
app.use(pinoHttp());

app.use(
  "/api/v1",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);

app.get("/health", (_request, response) =>
  response.json({ status: "ok", time: new Date().toISOString() }),
);

app.get("/api/v1/health", (_request, response) =>
  response.json({ status: "ok", time: new Date().toISOString() }),
);

app.post("/api/v1/auth/login", authLimiter, (request, response) => {
  const input = z.object({ password: z.string() }).safeParse(request.body);
  if (!input.success || input.data.password !== config.ADMIN_PASSWORD) {
    return response.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  return response.json({
    token: jwt.sign({ role: "admin" }, config.JWT_SECRET),
  });
});

app.use("/api", (request, response, next) => {
  try {
    jwt.verify(
      request.headers.authorization?.replace(/^Bearer /, "") ?? "",
      config.JWT_SECRET,
    );
    next();
  } catch {
    response.status(401).json({ error: "UNAUTHORIZED" });
  }
});

app.get("/api/v1/actions", (_request, response) =>
  response.json([
    { type: "key", key: "HOME", label: "Início" },
    { type: "key", key: "BACK", label: "Voltar" },
    { type: "key", key: "DPAD_UP", label: "Seta para cima" },
    { type: "key", key: "DPAD_DOWN", label: "Seta para baixo" },
    { type: "key", key: "DPAD_LEFT", label: "Seta para esquerda" },
    { type: "key", key: "DPAD_RIGHT", label: "Seta para direita" },
    { type: "key", key: "ENTER", label: "Botão OK" },
    { type: "key", key: "PLAY_PAUSE", label: "Reproduzir/Pausar" },
    { type: "key", key: "VOLUME_UP", label: "Aumentar volume" },
    { type: "key", key: "VOLUME_DOWN", label: "Diminuir volume" },
    { type: "key", key: "MUTE", label: "Silenciar" },
    { type: "text", label: "Digitar texto" },
    { type: "wait", label: "Aguardar" },
    { type: "openApp", label: "Abrir aplicativo" },
    { type: "callMacro", label: "Chamar outra macro" },
  ]),
);
type Resource = keyof typeof schemas;
const resources: Resource[] = ["devices", "macros", "commands"];

const columns: Record<Resource, Record<string, string>> = {
  devices: { name: "name", host: "host", port: "port", enabled: "enabled" },
  macros: {
    name: "name",
    description: "description",
    steps: "steps_json",
    requiresInput: "requires_input",
    inputLabel: "input_label",
    inputVariable: "input_variable",
    enabled: "enabled",
  },
  commands: {
    label: "label",
    aliases: "aliases_json",
    keys: "keys_json",
    enabled: "enabled",
  },
};

const arrayColumns = new Set(["steps", "phrases", "aliases", "keys"]);

function serialize(resource: Resource, value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(columns[resource]).map(([property, column]) => {
      const raw = value[property];
      return [
        column,
        Array.isArray(raw)
          ? JSON.stringify(raw)
          : typeof raw === "boolean"
            ? Number(raw)
            : raw,
      ];
    }),
  );
}

function deserialize(resource: Resource, row: Record<string, unknown>) {
  const output: Record<string, unknown> = { id: row["id"] };
  for (const [property, column] of Object.entries(columns[resource])) {
    const raw = row[column];
    output[property] =
      property === "enabled" || property === "requiresInput"
        ? Boolean(raw)
        : arrayColumns.has(property)
          ? JSON.parse(String(raw))
          : raw;
  }
  return output;
}

for (const resource of resources) {
  const orderBy = resource === "commands" ? "label" : "name";

  app.get(`/api/v1/${resource}`, (_request, response) => {
    const rows = db
      .prepare(`SELECT * FROM ${resource} ORDER BY ${orderBy}`)
      .all() as Record<string, unknown>[];
    response.json(rows.map((row) => deserialize(resource, row)));
  });

  app.post(`/api/v1/${resource}`, (request, response, next) => {
    try {
      const value = schemas[resource].parse(request.body) as Record<
        string,
        unknown
      >;
      const stored = serialize(resource, value);
      const names = ["id", ...Object.keys(stored)];
      db.prepare(
        `INSERT INTO ${resource} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
      ).run(value["id"], ...Object.values(stored));
      response.status(201).json(value);
    } catch (error) {
      next(error);
    }
  });

  app.put(`/api/v1/${resource}/:id`, (request, response, next) => {
    try {
      const value = schemas[resource].parse({
        ...request.body,
        id: request.params["id"],
      }) as Record<string, unknown>;
      const stored = serialize(resource, value);
      const result = db
        .prepare(
          `UPDATE ${resource} SET ${Object.keys(stored)
            .map((name) => `${name}=?`)
            .join(",")} WHERE id=?`,
        )
        .run(...Object.values(stored), value["id"]);
      result.changes
        ? response.json(value)
        : response.status(404).json({ error: "NOT_FOUND" });
    } catch (error) {
      next(error);
    }
  });

  app.delete(`/api/v1/${resource}/:id`, (request, response) => {
    const result = db
      .prepare(`DELETE FROM ${resource} WHERE id=?`)
      .run(request.params["id"]);
    result.changes
      ? response.status(204).send()
      : response.status(404).json({ error: "NOT_FOUND" });
  });
}
function getDevice(deviceId: string) {
  const row = db
    .prepare("SELECT host, port FROM devices WHERE id=? AND enabled=1")
    .get(deviceId) as { host: string; port: number } | undefined;
  return row ? new AdbService(row.host, row.port) : null;
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const busyDevices = new Set<string>();

async function executeMacroSteps(
  deviceId: string,
  macroId: string,
  variables: Record<string, string> = {},
  from = 0,
  to?: number,
  stack: string[] = [],
) {
  const adb = getDevice(deviceId);
  if (!adb) throw new Error("DEVICE_NOT_FOUND");
  if (stack.includes(macroId)) throw new Error("MACRO_CYCLE_DETECTED");
  if (stack.length >= 10) throw new Error("MACRO_NESTING_LIMIT");

  const row = db
    .prepare("SELECT steps_json FROM macros WHERE id=? AND enabled=1")
    .get(macroId) as { steps_json: string } | undefined;
  if (!row) throw new Error("MACRO_NOT_FOUND");

  const steps = z.array(stepSchema).parse(JSON.parse(row.steps_json));
  const last = Math.min(to ?? steps.length - 1, steps.length - 1);
  let executed = 0;
  for (let index = Math.max(0, from); index <= last; index += 1) {
    const step = steps[index];
    if (step.type === "key") await adb.key(step.key);
    if (step.type === "wait")
      await new Promise((resolve) => setTimeout(resolve, step.milliseconds));
    if (step.type === "openApp") await adb.openApp(step.packageName);
    if (step.type === "callMacro") {
      await executeMacroSteps(
        deviceId,
        step.macroId,
        variables,
        0,
        undefined,
        [...stack, macroId],
      );
    }
    if (step.type === "text") {
      const text = step.value.replace(
        /\{\{(\w+)\}\}/g,
        (_match, key: string) => variables[key] ?? "",
      );
      await adb.text(text);
    }
    executed += 1;
  }
  log(`macro:${macroId}`, "success", deviceId);
  return { ok: true, steps: executed };
}

async function runLocked<T>(deviceId: string, operation: () => Promise<T>) {
  if (busyDevices.has(deviceId)) throw new Error("DEVICE_BUSY");
  busyDevices.add(deviceId);
  try {
    return await operation();
  } finally {
    busyDevices.delete(deviceId);
  }
}

app.post(
  "/api/v1/devices/:deviceId/macros/:macroId/run",
  async (request, response, next) => {
    try {
      response.json(
        await runLocked(request.params["deviceId"], () =>
          executeMacroSteps(
            request.params["deviceId"],
            request.params["macroId"],
            request.body?.variables,
          ),
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/v1/devices/:deviceId/macros/:macroId/test",
  async (request, response, next) => {
    try {
      const range = z
        .object({
          from: z.number().int().min(0),
          to: z.number().int().min(0),
          variables: z.record(z.string()).default({}),
        })
        .parse(request.body);
      if (range.to < range.from) {
        return response.status(400).json({ error: "INVALID_STEP_RANGE" });
      }
      response.json(
        await runLocked(request.params["deviceId"], () =>
          executeMacroSteps(
            request.params["deviceId"],
            request.params["macroId"],
            range.variables,
            range.from,
            range.to,
          ),
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/v1/devices/:id/status", async (request, response) => {
  const adb = getDevice(request.params["id"]);
  adb
    ? response.json(await adb.status())
    : response.status(404).json({ error: "DEVICE_NOT_FOUND" });
});

app.get("/api/v1/devices/:id/screenshot", async (request, response, next) => {
  try {
    const adb = getDevice(request.params["id"]);
    if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
    const screenshot = await adb.screenshot();
    log("screenshot", "success", request.params["id"]);
    response
      .setHeader("Content-Type", "image/png")
      .setHeader("Cache-Control", "no-store");
    response.send(screenshot);
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1/devices/:id/diagnose", async (request, response, next) => {
  try {
    const adb = getDevice(request.params["id"]);
    if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
    const tailscale = await adb.tailscaleStatus();
    const adbStatus = await adb.status();
    const reachable =
      adbStatus.connection !== "unreachable" &&
      adbStatus.connection !== "unknown";
    const checks = [
      {
        id: "tailscale",
        label: "Rede (Tailscale)",
        ok: tailscale.ok,
        detail: tailscale.detail,
      },
      {
        id: "online",
        label: "Aparelho online",
        ok: reachable,
        detail: reachable
          ? "Respondendo na rede"
          : "Inacessível — pode estar desligado ou sem energia",
      },
      {
        id: "adb",
        label: "ADB autorizado",
        ok: adbStatus.connection === "device",
        detail:
          adbStatus.connection === "device"
            ? "Pronto para receber comandos"
            : adbStatus.connection === "unauthorized"
              ? 'Confirme "Sempre permitir" na tela da TV'
              : adbStatus.details.slice(0, 140),
      },
    ];
    response.json({
      device: adbStatus.device,
      online: checks.every((check) => check.ok),
      checks,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1/devices/:id/key", async (request, response, next) => {
  try {
    const adb = getDevice(request.params["id"]);
    if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
    const key = keyEnum.parse(request.body?.key);
    await adb.key(key);
    log(`key:${key}`, "success", request.params["id"]);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1/devices/:id/text", async (request, response, next) => {
  try {
    const adb = getDevice(request.params["id"]);
    if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
    const text = z.string().min(1).max(120).parse(request.body?.text);
    await adb.text(text);
    log("text", "success", request.params["id"]);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

const packageNameSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/);

app.get("/api/v1/devices/:id/apps", async (request, response, next) => {
  try {
    const adb = getDevice(request.params["id"]);
    if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
    const packages = await adb.listUserApps();
    const knownApps: Record<string, { name: string; icon: string; color: string }> = {
      "com.global.unitviptv": { name: "UniTV", icon: "bi-tv", color: "#4f7cff" },
      "com.netflix.ninja": { name: "Netflix", icon: "bi-badge-hd", color: "#e50914" },
      "com.stremio.one": { name: "Stremio", icon: "bi-play-circle", color: "#7b5cff" },
      "org.xbmc.kodi": { name: "Kodi", icon: "bi-diamond", color: "#17a7d6" },
      "com.spotify.tv.android": { name: "Spotify", icon: "bi-spotify", color: "#1db954" },
      "com.tailscale.ipn": { name: "Tailscale", icon: "bi-diagram-3", color: "#555b66" },
      "com.limelight": { name: "Moonlight", icon: "bi-moon-stars", color: "#32a852" },
      "tv.twitch.android.viewer": { name: "Twitch", icon: "bi-twitch", color: "#9146ff" },
      "com.google.android.apps.youtube.tv": { name: "YouTube", icon: "bi-youtube", color: "#ff0000" },
      "com.google.android.youtube": { name: "YouTube", icon: "bi-youtube", color: "#ff0000" },
      "com.globo.globotv": { name: "Globoplay", icon: "bi-play-btn", color: "#d40000" },
      "com.disney.disneyplus": { name: "Disney+", icon: "bi-stars", color: "#1f3d7d" },
      "tv.pluto.android": { name: "Pluto TV", icon: "bi-broadcast", color: "#f29100" },
      "com.plexapp.android": { name: "Plex", icon: "bi-collection-play", color: "#e5a00d" },
      "org.videolan.vlc": { name: "VLC", icon: "bi-play-btn", color: "#ff6d00" },
      "com.crunchyroll.crunchyroid": { name: "Crunchyroll", icon: "bi-film", color: "#f47521" },
      "com.hbo.hbomax": { name: "HBO Max", icon: "bi-badge-hd", color: "#46008c" },
      "com.paramount.plus": { name: "Paramount+", icon: "bi-play-circle", color: "#0f46b4" },
      "com.apple.atve.amp.tv": { name: "Apple TV", icon: "bi-apple", color: "#a1a1a6" },
      "com.mxtech.videoplayer.ad": { name: "MX Player", icon: "bi-collection-play", color: "#10af62" },
    };
    response.json(
      packages.map((packageName) => ({
        packageName,
        name: knownApps[packageName]?.name ?? packageName.split(".").at(-1),
        icon: knownApps[packageName]?.icon ?? "bi-app",
        color: knownApps[packageName]?.color ?? "#34465f",
      })),
    );
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/v1/devices/:id/apps/:packageName/open",
  async (request, response, next) => {
    try {
      const adb = getDevice(request.params["id"]);
      if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
      const packageName = packageNameSchema.parse(
        request.params["packageName"],
      );
      await adb.openApp(packageName);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

app.delete(
  "/api/v1/devices/:id/apps/:packageName",
  async (request, response, next) => {
    try {
      const adb = getDevice(request.params["id"]);
      if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
      const packageName = packageNameSchema.parse(
        request.params["packageName"],
      );
      await adb.uninstallApp(packageName);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/v1/devices/:id/apps/install",
  async (request, response, next) => {
    let directory = "";
    try {
      const adb = getDevice(request.params["id"]);
      if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
      if (!Buffer.isBuffer(request.body) || request.body.length < 4) {
        return response.status(400).json({ error: "INVALID_APK" });
      }
      directory = await mkdtemp(join(tmpdir(), "btv-apk-"));
      const apkPath = join(directory, "upload.apk");
      await writeFile(apkPath, request.body);
      await adb.installApp(apkPath);
      response.status(201).json({ ok: true });
    } catch (error) {
      next(error);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  },
);

app.post("/api/v1/commands/:commandId/run", async (request, response, next) => {
  try {
    const command = db
      .prepare(
        "SELECT id, label, keys_json FROM commands WHERE id=? AND enabled=1",
      )
      .get(request.params["commandId"]) as
      | { id: string; label: string; keys_json: string }
      | undefined;
    if (!command)
      return response.status(404).json({ error: "COMMAND_NOT_FOUND" });

    const device = db
      .prepare(
        "SELECT id FROM devices WHERE enabled=1 ORDER BY created_at LIMIT 1",
      )
      .get() as { id: string } | undefined;
    if (!device)
      return response.status(404).json({ error: "DEVICE_NOT_FOUND" });

    const adb = getDevice(device.id);
    if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });

    const keys = JSON.parse(command.keys_json) as RemoteKey[];
    for (const key of keys) await adb.key(key);
    log(`command:${command.id}`, "success", device.id);
    response.json({
      ok: true,
      commandId: command.id,
      deviceId: device.id,
      keys,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1/commands/resolve", (request, response) => {
  const input = z
    .object({ text: z.string().min(1).max(120) })
    .safeParse(request.body);
  if (!input.success)
    return response.status(400).json({ error: "INVALID_TEXT" });

  const target = normalizeText(input.data.text);
  const rows = db.prepare("SELECT * FROM commands WHERE enabled=1").all() as {
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
        status: "MATCHED",
        matchedAlias: match,
        command: {
          id: row.id,
          label: row.label,
          keys: JSON.parse(row.keys_json),
        },
      });
    }
  }
  response.status(404).json({ status: "NOT_FOUND" });
});

app.get("/api/v1/logs", (_request, response) =>
  response.json(
    db.prepare("SELECT * FROM execution_logs ORDER BY id DESC LIMIT 100").all(),
  ),
);

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("request", "error", message);
    if (message.startsWith("ADB_UNAUTHORIZED")) {
      return response.status(409).json({ error: "ADB_UNAUTHORIZED", message });
    }
    if (message.startsWith("ADB_OFFLINE")) {
      return response.status(503).json({ error: "ADB_OFFLINE", message });
    }
    if (message === "DEVICE_BUSY") {
      return response.status(409).json({
        error: "DEVICE_BUSY",
        message: "Já existe uma macro em execução neste dispositivo.",
      });
    }
    if (message === "MACRO_CYCLE_DETECTED" || message === "MACRO_NESTING_LIMIT") {
      return response.status(400).json({
        error: message,
        message: "A composição de macros possui uma referência circular ou profunda demais.",
      });
    }
    response.status(400).json({ error: "REQUEST_FAILED", message });
  },
);

app.listen(config.PORT, config.HOST, () =>
  console.log(`API on ${config.HOST}:${config.PORT}`),
);
