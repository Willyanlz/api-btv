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
import { randomUUID } from "node:crypto";

import { AdbService, keyCodes, RemoteKey } from "./adb.js";
import {
  getCachedIcon,
  removeCachedApp,
  synchronizeAppCache,
} from "./app-cache.js";
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

const atomicStepSchema = z.discriminatedUnion("type", [
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
  z.object({
    type: z.literal("clickButton"),
    buttonId: z.string().min(1).max(80),
  }),
  z.object({
    type: z.literal("clickFocused"),
  }),
]);

const stepSchema = z.discriminatedUnion("type", [
  ...atomicStepSchema.options,
  z.object({
    type: z.literal("screenCondition"),
    screenId: z.string().min(1).max(80),
    operator: z.enum(["is", "isNot"]).default("is"),
    whenTrue: z.array(atomicStepSchema).max(30),
    whenFalse: z.array(atomicStepSchema).max(30),
  }),
]);

type AppScreenRow = {
  id: string;
  package_name: string;
  friendly_name: string;
  activity_name: string;
};

type AppButtonRow = {
  id: string;
  screen_id: string;
  friendly_name: string;
  resource_id: string;
  text: string;
  content_desc: string;
  class_name: string;
  center_x: number;
  center_y: number;
  bounds: string;
};

function serializeAppButton(row: AppButtonRow) {
  return {
    id: row.id,
    screenId: row.screen_id,
    name: row.friendly_name,
    resourceId: row.resource_id,
    text: row.text,
    contentDesc: row.content_desc,
    className: row.class_name,
    centerX: row.center_x,
    centerY: row.center_y,
    bounds: row.bounds,
  };
}

const schemas = {
  devices: z.object({
    id,
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(5555),
    enabled,
  }),
  macros: z
    .object({
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
      appPackage: z.string().max(200).default(""),
      appOpenDelaySeconds: z.number().int().min(0).max(60).default(10),
      enabled,
    })
    .superRefine((value, context) => {
      for (const [index, step] of value.steps.entries()) {
        if (step.type === "screenCondition") {
          const screen = db
            .prepare("SELECT package_name FROM app_screens WHERE id = ?")
            .get(step.screenId) as { package_name: string } | undefined;
          if (
            !screen ||
            !value.appPackage ||
            screen.package_name !== value.appPackage
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["steps", index, "screenId"],
              message: "A tela escolhida não pertence ao aplicativo esperado.",
            });
          }
        }
        if (step.type === "clickButton") {
          const button = db
            .prepare(
              `SELECT s.package_name FROM app_buttons b
               JOIN app_screens s ON s.id = b.screen_id
               WHERE b.id = ?`,
            )
            .get(step.buttonId) as { package_name: string } | undefined;
          if (
            !button ||
            !value.appPackage ||
            button.package_name !== value.appPackage
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["steps", index, "buttonId"],
              message: "O botão escolhido não pertence ao aplicativo esperado.",
            });
          }
        }
      }
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
    { type: "screenCondition", label: "Verificar tela" },
    { type: "clickButton", label: "Clicar em botão" },
    { type: "clickFocused", label: "Clicar no foco" },
  ]),
);
app.get("/api/v1/screens", (request, response) => {
  const packageName = String(request.query["packageName"] ?? "");
  const rows = db
    .prepare(
      `SELECT id, package_name, friendly_name, activity_name
       FROM app_screens
       WHERE package_name = ?
       ORDER BY friendly_name`,
    )
    .all(packageName) as AppScreenRow[];
  response.json(rows.map((row) => ({ id: row.id, name: row.friendly_name })));
});
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
    appPackage: "app_package",
    appOpenDelaySeconds: "app_open_delay_seconds",
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

class MacroStepError extends Error {
  constructor(
    readonly macroId: string,
    readonly stepIndex: number,
    readonly causeMessage: string,
  ) {
    super(`MACRO_STEP_FAILED:${macroId}:${stepIndex + 1}:${causeMessage}`);
  }
}

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

  const executeStep = async (
    step: z.infer<typeof stepSchema> | z.infer<typeof atomicStepSchema>,
  ): Promise<void> => {
    if (step.type === "key") await adb.key(step.key);
    if (step.type === "wait") {
      await new Promise((resolve) => setTimeout(resolve, step.milliseconds));
    }
    if (step.type === "openApp") await adb.openApp(step.packageName);
    if (step.type === "callMacro") {
      await executeMacroSteps(deviceId, step.macroId, variables, 0, undefined, [
        ...stack,
        macroId,
      ]);
    }
    if (step.type === "text") {
      const text = step.value.replace(
        /\{\{(\w+)\}\}/g,
        (_match, key: string) => variables[key] ?? "",
      );
      await adb.text(text);
    }
    if (step.type === "screenCondition") {
      const screen = db
        .prepare(
          `SELECT id, package_name, friendly_name, activity_name
           FROM app_screens WHERE id = ?`,
        )
        .get(step.screenId) as AppScreenRow | undefined;
      if (!screen) throw new Error("UNKNOWN_SCREEN");
      const foreground = await adb.foreground();
      const isCurrentScreen =
        foreground.packageName === screen.package_name &&
        foreground.activityName === screen.activity_name;
      const conditionResult =
        step.operator === "isNot" ? !isCurrentScreen : isCurrentScreen;
      const branch = conditionResult ? step.whenTrue : step.whenFalse;
      const branchLabel = conditionResult ? "Se sim" : "Se não";
      for (const [branchIndex, branchStep] of branch.entries()) {
        try {
          await executeStep(branchStep);
        } catch (error) {
          if (error instanceof MacroStepError) throw error;
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(`${branchLabel}, ação ${branchIndex + 1}: ${cause}`);
        }
      }
    }
    if (step.type === "clickFocused") {
      await adb.clickFocused();
    }
    if (step.type === "clickButton") {
      const button = db
        .prepare("SELECT * FROM app_buttons WHERE id = ?")
        .get(step.buttonId) as
        | {
            id: string;
            screen_id: string;
            friendly_name: string;
            resource_id: string;
            text: string;
            content_desc: string;
            class_name: string;
            center_x: number;
            center_y: number;
            bounds: string;
          }
        | undefined;
      if (!button) throw new Error("BUTTON_NOT_FOUND");
      const foreground = await adb.foreground();
      const screen = db
        .prepare(
          `SELECT package_name FROM app_screens WHERE id = ?`,
        )
        .get(button.screen_id) as { package_name: string } | undefined;
      const expectedPackage = screen?.package_name;
      if (
        expectedPackage &&
        foreground.packageName &&
        foreground.packageName !== expectedPackage
      ) {
        throw new Error(
          `BUTTON_WRONG_APP: o app aberto não é o esperado para "${button.friendly_name}"`,
        );
      }
      const nodes = await adb.uiDump();
      const found = adb.findNode(nodes, {
        resourceId: button.resource_id || undefined,
        contentDesc: button.content_desc || undefined,
        text: button.text || undefined,
      });
      if (found) {
        await adb.tap(found.centerX, found.centerY);
      } else if (button.center_x && button.center_y) {
        await adb.tap(button.center_x, button.center_y);
      } else {
        throw new Error(
          `BUTTON_NOT_FOUND: o botão "${button.friendly_name}" não foi localizado e não há posição salva.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  };

  for (let index = Math.max(0, from); index <= last; index += 1) {
    const step = steps[index];
    try {
      await executeStep(step);
    } catch (error) {
      if (error instanceof MacroStepError) throw error;
      throw new MacroStepError(
        macroId,
        index,
        error instanceof Error ? error.message : String(error),
      );
    }
    executed += 1;
  }
  log(`macro:${macroId}`, "success", deviceId);
  return { ok: true, steps: executed };
}

function getMacroRequiredApp(deviceId: string, macroId: string) {
  return db
    .prepare(
      `SELECT macros.app_package AS package_name,
              macros.app_open_delay_seconds AS delay_seconds,
              COALESCE(device_app_cache.name, macros.app_package) AS name
       FROM macros
       LEFT JOIN device_app_cache
         ON device_app_cache.package_name = macros.app_package
        AND device_app_cache.device_id = ?
       WHERE macros.id = ?`,
    )
    .get(deviceId, macroId) as
    { package_name: string; name: string; delay_seconds: number } | undefined;
}

app.get(
  "/api/v1/devices/:deviceId/macros/:macroId/preflight",
  async (request, response, next) => {
    try {
      const adb = getDevice(request.params["deviceId"]);
      if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
      const requiredApp = getMacroRequiredApp(
        request.params["deviceId"],
        request.params["macroId"],
      );
      if (!requiredApp?.package_name) {
        return response.json({ ready: true, requiredApp: null });
      }
      const foreground = await adb.foreground();
      response.json({
        ready: foreground.packageName === requiredApp.package_name,
        requiredApp: {
          packageName: requiredApp.package_name,
          name: requiredApp.name,
          delaySeconds: requiredApp.delay_seconds,
        },
        foregroundPackage: foreground.packageName,
      });
    } catch (error) {
      next(error);
    }
  },
);

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
      const options = z
        .object({
          variables: z.record(z.string()).default({}),
          openRequiredApp: z.boolean().default(false),
        })
        .parse(request.body ?? {});
      response.json(
        await runLocked(request.params["deviceId"], async () => {
          const requiredApp = getMacroRequiredApp(
            request.params["deviceId"],
            request.params["macroId"],
          );
          if (options.openRequiredApp && requiredApp?.package_name) {
            const adb = getDevice(request.params["deviceId"]);
            if (!adb) throw new Error("DEVICE_NOT_FOUND");
            await adb.openApp(requiredApp.package_name);
            await new Promise((resolve) =>
              setTimeout(resolve, requiredApp.delay_seconds * 1_000),
            );
          }
          return executeMacroSteps(
            request.params["deviceId"],
            request.params["macroId"],
            options.variables,
          );
        }),
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

app.get(
  "/api/v1/devices/:id/settings/tailscale-always-on",
  async (request, response, next) => {
    try {
      const adb = getDevice(request.params["id"]);
      if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
      response.json(await adb.tailscaleAlwaysOnStatus());
    } catch (error) {
      next(error);
    }
  },
);

app.put(
  "/api/v1/devices/:id/settings/tailscale-always-on",
  async (request, response, next) => {
    try {
      const adb = getDevice(request.params["id"]);
      if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
      const { enabled } = z
        .object({ enabled: z.boolean() })
        .parse(request.body);
      response.json(await adb.setTailscaleAlwaysOn(enabled));
    } catch (error) {
      next(error);
    }
  },
);

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
const activityNameSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_.$]*(\.[a-zA-Z0-9_.$]+)+$/)
  .max(240);
const appScreenInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  activityName: activityNameSchema,
});

const appButtonInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  resourceId: z.string().max(240).optional(),
  text: z.string().max(240).optional(),
  contentDesc: z.string().max(240).optional(),
  className: z.string().max(240).optional(),
  centerX: z.number().int().min(0).optional(),
  centerY: z.number().int().min(0).optional(),
  bounds: z.string().max(240).optional(),
});

function serializeAppScreen(row: AppScreenRow) {
  return {
    id: row.id,
    packageName: row.package_name,
    name: row.friendly_name,
    activityName: row.activity_name,
  };
}

app.get("/api/v1/apps/:packageName/screens", (request, response, next) => {
  try {
    const packageName = packageNameSchema.parse(request.params["packageName"]);
    const rows = db
      .prepare(
        `SELECT id, package_name, friendly_name, activity_name
         FROM app_screens WHERE package_name = ? ORDER BY friendly_name`,
      )
      .all(packageName) as AppScreenRow[];
    response.json(rows.map(serializeAppScreen));
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1/apps/:packageName/screens", (request, response, next) => {
  try {
    const packageName = packageNameSchema.parse(request.params["packageName"]);
    const value = appScreenInputSchema.parse(request.body);
    const row: AppScreenRow = {
      id: randomUUID(),
      package_name: packageName,
      friendly_name: value.name,
      activity_name: value.activityName,
    };
    db.prepare(
      `INSERT INTO app_screens
        (id, package_name, friendly_name, activity_name)
       VALUES (?, ?, ?, ?)`,
    ).run(row.id, row.package_name, row.friendly_name, row.activity_name);
    response.status(201).json(serializeAppScreen(row));
  } catch (error) {
    next(error);
  }
});

app.put("/api/v1/app-screens/:id", (request, response, next) => {
  try {
    const value = appScreenInputSchema.parse(request.body);
    const result = db
      .prepare(
        `UPDATE app_screens SET friendly_name = ?, activity_name = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(value.name, value.activityName, request.params["id"]);
    if (!result.changes)
      return response.status(404).json({ error: "SCREEN_NOT_FOUND" });
    response.json({ id: request.params["id"], ...value });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/v1/app-screens/:id", (request, response, next) => {
  try {
    const used = (
      db.prepare("SELECT steps_json FROM macros").all() as {
        steps_json: string;
      }[]
    ).some((row) =>
      row.steps_json.includes(`\"screenId\":\"${request.params["id"]}\"`),
    );
    if (used) {
      return response.status(409).json({
        error: "SCREEN_IN_USE",
        message:
          "Esta tela está sendo usada por uma macro e não pode ser excluída.",
      });
    }
    const result = db
      .prepare("DELETE FROM app_screens WHERE id = ?")
      .run(request.params["id"]);
    result.changes
      ? response.status(204).send()
      : response.status(404).json({ error: "SCREEN_NOT_FOUND" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/v1/apps/:packageName/screens/:screenId/buttons", (request, response, next) => {
  try {
    const screenId = z.string().min(1).max(80).parse(request.params["screenId"]);
    const screen = db
      .prepare("SELECT id FROM app_screens WHERE id = ?")
      .get(screenId) as { id: string } | undefined;
    if (!screen) return response.status(404).json({ error: "SCREEN_NOT_FOUND" });
    const rows = db
      .prepare(
        `SELECT * FROM app_buttons WHERE screen_id = ? ORDER BY friendly_name`,
      )
      .all(screenId) as AppButtonRow[];
    response.json(rows.map(serializeAppButton));
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1/apps/:packageName/screens/:screenId/buttons", (request, response, next) => {
  try {
    const screenId = z.string().min(1).max(80).parse(request.params["screenId"]);
    const screen = db
      .prepare("SELECT id FROM app_screens WHERE id = ?")
      .get(screenId) as { id: string } | undefined;
    if (!screen) return response.status(404).json({ error: "SCREEN_NOT_FOUND" });
    const value = appButtonInputSchema.parse(request.body);
    const row: AppButtonRow = {
      id: randomUUID(),
      screen_id: screenId,
      friendly_name: value.name,
      resource_id: value.resourceId ?? "",
      text: value.text ?? "",
      content_desc: value.contentDesc ?? "",
      class_name: value.className ?? "",
      center_x: value.centerX ?? 0,
      center_y: value.centerY ?? 0,
      bounds: value.bounds ?? "",
    };
    db.prepare(
      `INSERT INTO app_buttons
        (id, screen_id, friendly_name, resource_id, text, content_desc,
         class_name, center_x, center_y, bounds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.screen_id,
      row.friendly_name,
      row.resource_id,
      row.text,
      row.content_desc,
      row.class_name,
      row.center_x,
      row.center_y,
      row.bounds,
    );
    response.status(201).json(serializeAppButton(row));
  } catch (error) {
    next(error);
  }
});

app.put("/api/v1/app-buttons/:id", (request, response, next) => {
  try {
    const value = appButtonInputSchema.parse(request.body);
    const result = db
      .prepare(
        `UPDATE app_buttons SET friendly_name = ?, resource_id = ?, text = ?,
          content_desc = ?, class_name = ?, center_x = ?, center_y = ?,
          bounds = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(
        value.name,
        value.resourceId ?? "",
        value.text ?? "",
        value.contentDesc ?? "",
        value.className ?? "",
        value.centerX ?? 0,
        value.centerY ?? 0,
        value.bounds ?? "",
        request.params["id"],
      );
    if (!result.changes)
      return response.status(404).json({ error: "BUTTON_NOT_FOUND" });
    const row = db
      .prepare("SELECT * FROM app_buttons WHERE id = ?")
      .get(request.params["id"]) as AppButtonRow;
    response.json(serializeAppButton(row));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/v1/app-buttons/:id", (request, response, next) => {
  try {
    const used = (
      db.prepare("SELECT steps_json FROM macros").all() as {
        steps_json: string;
      }[]
    ).some((row) =>
      row.steps_json.includes(`\"buttonId\":\"${request.params["id"]}\"`),
    );
    if (used) {
      return response.status(409).json({
        error: "BUTTON_IN_USE",
        message:
          "Este botão está sendo usado por uma macro e não pode ser excluído.",
      });
    }
    const result = db
      .prepare("DELETE FROM app_buttons WHERE id = ?")
      .run(request.params["id"]);
    result.changes
      ? response.status(204).send()
      : response.status(404).json({ error: "BUTTON_NOT_FOUND" });
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/v1/devices/:id/current-screen",
  async (request, response, next) => {
    try {
      const adb = getDevice(request.params["id"]);
      if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
      const foreground = await adb.foreground();
      const cached = foreground.packageName
        ? (db
            .prepare(
              `SELECT name FROM device_app_cache
               WHERE device_id = ? AND package_name = ?`,
            )
            .get(request.params["id"], foreground.packageName) as
            { name: string } | undefined)
        : undefined;
      const screen =
        foreground.packageName && foreground.activityName
          ? (db
              .prepare(
                `SELECT id, package_name, friendly_name, activity_name
                 FROM app_screens
                 WHERE package_name = ? AND activity_name = ?`,
              )
              .get(foreground.packageName, foreground.activityName) as
              AppScreenRow | undefined)
          : undefined;
      response.json({
        packageName: foreground.packageName,
        appName: cached?.name ?? foreground.packageName,
        activityName: foreground.activityName,
        screen: screen ? serializeAppScreen(screen) : null,
      });
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/v1/devices/:id/apps/:packageName/screens/capture",
  async (request, response, next) => {
    try {
      const adb = getDevice(request.params["id"]);
      if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
      const packageName = packageNameSchema.parse(
        request.params["packageName"],
      );
      const name = z.string().trim().min(2).max(80).parse(request.body?.name);
      const foreground = await adb.foreground();
      if (foreground.packageName !== packageName || !foreground.activityName) {
        return response.status(409).json({
          error: "APP_NOT_IN_FOREGROUND",
          message: "Abra este aplicativo na tela que deseja cadastrar.",
        });
      }
      const row: AppScreenRow = {
        id: randomUUID(),
        package_name: packageName,
        friendly_name: name,
        activity_name: activityNameSchema.parse(foreground.activityName),
      };
      db.prepare(
        `INSERT INTO app_screens
          (id, package_name, friendly_name, activity_name)
         VALUES (?, ?, ?, ?)`,
      ).run(row.id, row.package_name, row.friendly_name, row.activity_name);
      response.status(201).json(serializeAppScreen(row));
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  `/api/v1/devices/:id/apps/:packageName/screens/:screenId/focus`,
  async (request, response, next) => {
    try {
      const adb = getDevice(request.params["id"]);
      if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
      const screenId = z.string().min(1).max(80).parse(request.params["screenId"]);
      const screen = db
        .prepare(`SELECT id FROM app_screens WHERE id = ?`)
        .get(screenId) as { id: string } | undefined;
      if (!screen) return response.status(404).json({ error: "SCREEN_NOT_FOUND" });
      const node = await adb.focusedNode();
      response.json({ node });
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  `/api/v1/devices/:id/apps/:packageName/screens/:screenId/focus/capture`,
  async (request, response, next) => {
    try {
      const adb = getDevice(request.params["id"]);
      if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
      const screenId = z.string().min(1).max(80).parse(request.params["screenId"]);
      const screen = db
        .prepare(`SELECT id, package_name FROM app_screens WHERE id = ?`)
        .get(screenId) as { id: string; package_name: string } | undefined;
      if (!screen) return response.status(404).json({ error: "SCREEN_NOT_FOUND" });
      const packageName = packageNameSchema.parse(screen.package_name);
      const name = z.string().trim().min(2).max(80).parse(request.body?.name);
      const foreground = await adb.foreground();
      if (foreground.packageName !== packageName) {
        return response.status(409).json({
          error: "APP_NOT_IN_FOREGROUND",
          message: "Abra este aplicativo na tela que deseja cadastrar.",
        });
      }
      const node = await adb.focusedNode();
      if (!node) {
        return response.status(409).json({
          error: "NO_FOCUSED_NODE",
          message: "Não foi possível identificar o botão focado.",
        });
      }
      const row = {
        id: randomUUID(),
        screen_id: screenId,
        friendly_name: name,
        resource_id: node.resourceId,
        text: node.text,
        content_desc: node.contentDesc,
        class_name: node.className,
        center_x: node.centerX,
        center_y: node.centerY,
        bounds: node.bounds,
      };
      db.prepare(
        `INSERT INTO app_buttons
          (id, screen_id, friendly_name, resource_id, text, content_desc,
           class_name, center_x, center_y, bounds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.screen_id,
        row.friendly_name,
        row.resource_id,
        row.text,
        row.content_desc,
        row.class_name,
        row.center_x,
        row.center_y,
        row.bounds,
      );
      const created = db
        .prepare(`SELECT * FROM app_buttons WHERE id = ?`)
        .get(row.id) as AppButtonRow;
      response.status(201).json(serializeAppButton(created));
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/v1/devices/:id/apps", async (request, response, next) => {
  try {
    const adb = getDevice(request.params["id"]);
    if (!adb) return response.status(404).json({ error: "DEVICE_NOT_FOUND" });
    response.json(await synchronizeAppCache(request.params["id"], adb));
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/v1/devices/:id/apps/:packageName/icon",
  (request, response, next) => {
    try {
      const packageName = packageNameSchema.parse(
        request.params["packageName"],
      );
      const icon = getCachedIcon(request.params["id"], packageName);
      if (!icon?.icon_blob || !icon.icon_mime_type) {
        return response.status(404).json({ error: "APP_ICON_NOT_FOUND" });
      }
      response
        .setHeader("Content-Type", icon.icon_mime_type)
        .setHeader("Cache-Control", "private, max-age=86400");
      response.send(icon.icon_blob);
    } catch (error) {
      next(error);
    }
  },
);

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
      removeCachedApp(request.params["id"], packageName);
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
      { id: string; label: string; keys_json: string } | undefined;
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
    if (message.includes("UNIQUE constraint failed: app_screens")) {
      return response.status(409).json({
        error: "SCREEN_ALREADY_EXISTS",
        message: "Já existe uma tela com este nome ou código neste aplicativo.",
      });
    }
    if (error instanceof MacroStepError) {
      return response.status(400).json({
        error: "MACRO_STEP_FAILED",
        message: `A macro falhou no passo ${error.stepIndex + 1}.`,
        macroId: error.macroId,
        stepIndex: error.stepIndex,
        stepNumber: error.stepIndex + 1,
        cause: error.causeMessage,
      });
    }
    if (message === "TAILSCALE_NOT_INSTALLED") {
      return response.status(400).json({
        error: message,
        message: "O aplicativo Tailscale não está instalado neste aparelho.",
      });
    }
    if (message.startsWith("TAILSCALE_ALWAYS_ON_VERIFICATION_FAILED")) {
      return response.status(409).json({
        error: message,
        message:
          "O aparelho não confirmou a configuração. Este Android pode bloquear a alteração via ADB.",
      });
    }
    if (
      message === "MACRO_CYCLE_DETECTED" ||
      message === "MACRO_NESTING_LIMIT"
    ) {
      return response.status(400).json({
        error: message,
        message:
          "A composição de macros possui uma referência circular ou profunda demais.",
      });
    }
    response.status(400).json({ error: "REQUEST_FAILED", message });
  },
);

app.listen(config.PORT, config.HOST, () =>
  console.log(`API on ${config.HOST}:${config.PORT}`),
);
