import { execFile } from "node:child_process";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const keyCodes = {
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  ENTER: 66,
  PLAY_PAUSE: 85,
  MUTE: 164,
} as const;

export type RemoteKey = keyof typeof keyCodes;

export type FocusDirection = "UP" | "DOWN" | "LEFT" | "RIGHT";

export interface AppMetadata {
  name: string | null;
  icon: Buffer | null;
  iconMimeType: "image/png" | "image/webp" | null;
}

export interface UiNode {
  resourceId: string;
  text: string;
  contentDesc: string;
  className: string;
  package: string;
  bounds: string;
  clickable: boolean;
  focused: boolean;
  centerX: number;
  centerY: number;
}

export class AdbService {
  constructor(
    private readonly host: string,
    private readonly port = 5555,
  ) {}

  private get target() {
    return `${this.host}:${this.port}`;
  }

  private execute(
    args: string[],
    options: Record<string, unknown> = { encoding: "utf8" },
  ) {
    return run("adb", args, {
      timeout: 15_000,
      maxBuffer: 5_000_000,
      ...options,
    });
  }

  private async ensureConnected() {
    let { stdout } = await this.execute(["devices", "-l"]);
    let line = String(stdout)
      .split("\n")
      .find((item) => item.startsWith(this.target));
    if (!line?.includes("device")) {
      try {
        await this.execute(["connect", this.target]);
      } catch {
        // O estado detalhado abaixo produz uma mensagem mais útil que o stderr do connect.
      }
      ({ stdout } = await this.execute(["devices", "-l"]));
      line = String(stdout)
        .split("\n")
        .find((item) => item.startsWith(this.target));
    }
    if (line?.includes("unauthorized")) {
      throw new Error(
        'ADB_UNAUTHORIZED: confirme "Sempre permitir deste computador" na TV Box.',
      );
    }
    if (!line || !line.includes("device")) {
      throw new Error(
        `ADB_OFFLINE: não foi possível conectar a ${this.target}.`,
      );
    }
  }

  async status() {
    try {
      await this.execute(["connect", this.target]);
      const { stdout } = await this.execute(["devices", "-l"]);
      const output = String(stdout);
      const normalized = output.replace(/\s+/g, " ");
      const connection = normalized.includes(`${this.target} device`)
        ? "device"
        : output.includes("unauthorized")
          ? "unauthorized"
          : output.includes("offline")
            ? "offline"
            : "unknown";
      return { device: this.target, connection, details: output.trim() };
    } catch (error) {
      return {
        device: this.target,
        connection: "unreachable",
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async key(key: RemoteKey) {
    await this.ensureConnected();
    await this.execute([
      "-s",
      this.target,
      "shell",
      "input",
      "keyevent",
      String(keyCodes[key]),
    ]);
  }

  async text(value: string) {
    await this.ensureConnected();
    const normalized = value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
    const words = normalized.split(/\s+/).filter(Boolean);

    for (const [index, word] of words.entries()) {
      const safeWord = word.replace(/[^a-zA-Z0-9._@-]/g, "");
      if (safeWord) {
        await this.execute([
          "-s",
          this.target,
          "shell",
          "input",
          "text",
          safeWord,
        ]);
      }
      if (index < words.length - 1) {
        await this.execute([
          "-s",
          this.target,
          "shell",
          "input",
          "keyevent",
          "62",
        ]);
      }
    }
  }

  async openApp(packageName: string) {
    await this.ensureConnected();
    await this.execute([
      "-s",
      this.target,
      "shell",
      "monkey",
      "-p",
      packageName,
      "1",
    ]);
  }

  async listUserApps() {
    await this.ensureConnected();
    const { stdout } = await this.execute([
      "-s",
      this.target,
      "shell",
      "pm",
      "list",
      "packages",
      "-3",
    ]);
    return String(stdout)
      .split("\n")
      .map((line) => line.trim().replace(/^package:/, ""))
      .filter(
        (name) =>
          Boolean(name) &&
          !name.startsWith("com.amazon.") &&
          !name.startsWith("amazon."),
      )
      .sort();
  }

  async extractAppMetadata(packageName: string): Promise<AppMetadata> {
    await this.ensureConnected();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "btv-app-"));
    const apkPath = join(temporaryDirectory, "base.apk");

    try {
      const { stdout: pathOutput } = await this.execute([
        "-s",
        this.target,
        "shell",
        "pm",
        "path",
        packageName,
      ]);
      const remotePath = String(pathOutput)
        .split("\n")
        .map((line) => line.trim().replace(/^package:/, ""))
        .find((path) => path.endsWith(".apk"));

      if (!remotePath) {
        throw new Error(`APP_APK_NOT_FOUND: ${packageName}`);
      }

      await this.execute(["-s", this.target, "pull", remotePath, apkPath], {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 5_000_000,
      });

      const { stdout: badgingOutput } = await run(
        "aapt",
        ["dump", "badging", apkPath],
        {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 10_000_000,
        },
      );
      const badging = String(badgingOutput);
      const name =
        badging.match(/^application-label:'([^']*)'/m)?.[1] ??
        badging.match(/^application: label='([^']*)'/m)?.[1] ??
        null;
      const iconPath =
        badging.match(/^application: .* icon='([^']+)'/m)?.[1] ?? null;
      const supportedIcon =
        iconPath && /\.(png|webp)$/i.test(iconPath) ? iconPath : null;

      if (!supportedIcon) {
        return { name, icon: null, iconMimeType: null };
      }

      const { stdout: iconOutput } = await run(
        "unzip",
        ["-p", apkPath, supportedIcon],
        {
          encoding: null,
          timeout: 30_000,
          maxBuffer: 10_000_000,
        },
      );
      const extension = supportedIcon.toLowerCase().endsWith(".webp")
        ? "image/webp"
        : "image/png";

      return {
        name,
        icon: Buffer.from(iconOutput as unknown as Uint8Array),
        iconMimeType: extension,
      };
    } finally {
      await rm(apkPath, { force: true });
      await rmdir(temporaryDirectory).catch(() => undefined);
    }
  }

  async uninstallApp(packageName: string) {
    await this.ensureConnected();
    const { stdout } = await this.execute([
      "-s",
      this.target,
      "uninstall",
      packageName,
    ]);
    if (!String(stdout).includes("Success")) {
      throw new Error(`APP_UNINSTALL_FAILED: ${String(stdout).trim()}`);
    }
  }

  async installApp(apkPath: string) {
    await this.ensureConnected();
    const { stdout } = await run(
      "adb",
      ["-s", this.target, "install", "-r", apkPath],
      {
        timeout: 180_000,
        maxBuffer: 5_000_000,
        encoding: "utf8",
      },
    );
    if (!String(stdout).includes("Success")) {
      throw new Error(`APP_INSTALL_FAILED: ${String(stdout).trim()}`);
    }
  }

  async foreground() {
    await this.ensureConnected();
    const { stdout } = await this.execute([
      "-s",
      this.target,
      "shell",
      "dumpsys",
      "activity",
      "activities",
    ]);
    const foreground =
      String(stdout)
        .split("\n")
        .find((line) => line.includes("mResumedActivity"))
        ?.trim() ?? null;
    const packageName = foreground?.match(
      /\s([a-zA-Z][a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.$]+/,
    )?.[1];
    const rawActivityName = foreground?.match(
      /\s[a-zA-Z][a-zA-Z0-9_.]+\/([a-zA-Z0-9_.$]+)/,
    )?.[1];
    const activityName = rawActivityName?.startsWith(".")
      ? `${packageName}${rawActivityName}`
      : rawActivityName;
    return {
      foreground,
      packageName: packageName ?? null,
      activityName: activityName ?? null,
    };
  }

  async tailscaleAlwaysOnStatus() {
    await this.ensureConnected();
    const application = await this.getSecureSetting("always_on_vpn_app");
    const lockdown = await this.getSecureSetting("always_on_vpn_lockdown");
    return {
      enabled: application === "com.tailscale.ipn",
      application,
      lockdown: lockdown === "1",
    };
  }

  async setTailscaleAlwaysOn(enabled: boolean) {
    await this.ensureConnected();
    if (enabled) {
      const { stdout } = await this.execute([
        "-s",
        this.target,
        "shell",
        "pm",
        "path",
        "com.tailscale.ipn",
      ]);
      if (!String(stdout).includes("package:")) {
        throw new Error("TAILSCALE_NOT_INSTALLED");
      }
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        if (enabled) {
          await this.putSecureSetting("always_on_vpn_app", "com.tailscale.ipn");
        } else {
          await this.execute([
            "-s",
            this.target,
            "shell",
            "settings",
            "delete",
            "secure",
            "always_on_vpn_app",
          ]);
        }
        await this.putSecureSetting("always_on_vpn_lockdown", "0");
        const status = await this.tailscaleAlwaysOnStatus();
        if (status.enabled === enabled && !status.lockdown) return status;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(
      `TAILSCALE_ALWAYS_ON_VERIFICATION_FAILED: ${
        lastError instanceof Error ? lastError.message : "estado não confirmado"
      }`,
    );
  }

  private async getSecureSetting(name: string) {
    const { stdout } = await this.execute([
      "-s",
      this.target,
      "shell",
      "settings",
      "get",
      "secure",
      name,
    ]);
    const value = String(stdout).trim();
    return value && value !== "null" ? value : null;
  }

  private async putSecureSetting(name: string, value: string) {
    await this.execute([
      "-s",
      this.target,
      "shell",
      "settings",
      "put",
      "secure",
      name,
      value,
    ]);
  }

  async screenshot() {
    await this.ensureConnected();
    const { stdout } = await this.execute(
      ["-s", this.target, "exec-out", "screencap", "-p"],
      { encoding: null },
    );
    return Buffer.from(stdout as unknown as Uint8Array);
  }

  /** Roda o uiautomator dump e devolve nós como objetos. */
  async uiDump(): Promise<UiNode[]> {
    await this.ensureConnected();
    const { stdout } = await this.execute([
      "-s",
      this.target,
      "shell",
      "uiautomator",
      "dump",
      "/sdcard/wd.xml",
    ]);
    const { stdout: xml } = await this.execute([
      "-s",
      this.target,
      "shell",
      "cat",
      "/sdcard/wd.xml",
    ]);
    // limpa arquivo temporário na TV
    try {
      await this.execute(["-s", this.target, "shell", "rm", "-f", "/sdcard/wd.xml"]);
    } catch {
      // arquivo pode já ter sido removido
    }
    void stdout;
    const nodes: UiNode[] = [];
    const regex =
      /<node\b[^>]*>/g;
    for (const match of String(xml).matchAll(regex)) {
      const tag = match[0];
      const attr = (name: string) =>
        new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
      const bounds = attr("bounds");
      const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds);
      const clickable = attr("clickable");
      nodes.push({
        resourceId: attr("resource-id"),
        text: attr("text"),
        contentDesc: attr("content-desc"),
        className: attr("class"),
        package: attr("package"),
        bounds,
        clickable: clickable === "true",
        focused: attr("focused") === "true",
        centerX:
          m ? Math.round((Number(m[1]) + Number(m[3])) / 2) : 0,
        centerY:
          m ? Math.round((Number(m[2]) + Number(m[4])) / 2) : 0,
      });
    }
    return nodes;
  }

  /** Nó focado (focused="true"). */
  async focusedNode(): Promise<UiNode | null> {
    const nodes = await this.uiDump();
    return nodes.find((node) => node.focused) ?? null;
  }

  /** Localiza um nó por seletor (resourceId → contentDesc → text). */
  findNode(nodes: UiNode[], selector: { resourceId?: string; contentDesc?: string; text?: string }) {
    if (selector.resourceId) {
      const hit = nodes.find((node) => node.resourceId === selector.resourceId);
      if (hit) return hit;
    }
    if (selector.contentDesc) {
      const hit = nodes.find((node) => node.contentDesc === selector.contentDesc);
      if (hit) return hit;
    }
    if (selector.text) {
      const hit = nodes.find((node) => node.text === selector.text);
      if (hit) return hit;
    }
    return null;
  }

  /** Toque por coordenada (input tap). */
  async tap(x: number, y: number) {
    await this.ensureConnected();
    await this.execute([
      "-s",
      this.target,
      "shell",
      "input",
      "tap",
      String(Math.round(x)),
      String(Math.round(y)),
    ]);
  }

  /** Clica no elemento focado (DPAD_CENTER). */
  async clickFocused() {
    await this.key("ENTER");
  }

  /** Identidade estável de um nó (para o grafo de rotas de foco). */
  nodeIdentity(node: UiNode): string {
    if (node.resourceId) return `id:${node.resourceId}`;
    if (node.text) return `t:${node.text}`;
    if (node.contentDesc) return `d:${node.contentDesc}`;
    return `c:${node.className}:${node.centerX},${node.centerY}`;
  }

  /** Verdadeiro se o nó casa com o seletor (mesma prioridade do findNode). */
  matchesSelector(
    node: UiNode,
    selector: { resourceId?: string; contentDesc?: string; text?: string },
  ): boolean {
    if (selector.resourceId && node.resourceId === selector.resourceId)
      return true;
    if (selector.contentDesc && node.contentDesc === selector.contentDesc)
      return true;
    if (selector.text && node.text === selector.text) return true;
    return false;
  }

  /** Pressiona uma seta de navegação de foco. */
  async pressDirection(direction: FocusDirection) {
    const map: Record<FocusDirection, RemoteKey> = {
      UP: "DPAD_UP",
      DOWN: "DPAD_DOWN",
      LEFT: "DPAD_LEFT",
      RIGHT: "DPAD_RIGHT",
    };
    await this.key(map[direction]);
  }

  /**
   * Navega com D-pad até o foco aterrissar no elemento alvo (não clica).
   * Usa heurística geométrica por passo e re-dump a cada tecla; registra as
   * transições observadas via onEdge para aprendizado de rotas.
   */
  async focusTarget(opts: {
    selector: { resourceId?: string; contentDesc?: string; text?: string };
    maxSteps?: number;
    onEdge?: (from: string, direction: FocusDirection, to: string) => void;
  }): Promise<{ reached: boolean; stepsUsed: number }> {
    const maxSteps = opts.maxSteps ?? 16;
    let nodes = await this.uiDump();
    let focused = nodes.find((node) => node.focused);
    if (focused && this.matchesSelector(focused, opts.selector)) {
      return { reached: true, stepsUsed: 0 };
    }
    let steps = 0;
    while (steps < maxSteps) {
      const target = this.findNode(nodes, opts.selector);
      if (!target) break;
      focused = nodes.find((node) => node.focused);
      if (!focused) break;
      const from = this.nodeIdentity(focused);
      const dx = target.centerX - focused.centerX;
      const dy = target.centerY - focused.centerY;
      const primary: FocusDirection =
        Math.abs(dx) > Math.abs(dy)
          ? dx > 0
            ? "RIGHT"
            : "LEFT"
          : dy > 0
            ? "DOWN"
            : "UP";
      await this.pressDirection(primary);
      nodes = await this.uiDump();
      steps += 1;
      const after = nodes.find((node) => node.focused);
      if (after) opts.onEdge?.(from, primary, this.nodeIdentity(after));
      if (after && this.matchesSelector(after, opts.selector)) {
        return { reached: true, stepsUsed: steps };
      }
      // Se o foco não se moveu, tenta o eixo secundário antes de desistir.
      if (after && this.nodeIdentity(after) === from) {
        const secondary: FocusDirection =
          Math.abs(dx) > Math.abs(dy)
            ? dy > 0
              ? "DOWN"
              : "UP"
            : dx > 0
              ? "RIGHT"
              : "LEFT";
        await this.pressDirection(secondary);
        nodes = await this.uiDump();
        steps += 1;
        const afterAlt = nodes.find((node) => node.focused);
        if (afterAlt)
          opts.onEdge?.(from, secondary, this.nodeIdentity(afterAlt));
        if (afterAlt && this.matchesSelector(afterAlt, opts.selector)) {
          return { reached: true, stepsUsed: steps };
        }
        if (afterAlt && this.nodeIdentity(afterAlt) === from) break;
      }
    }
    return { reached: false, stepsUsed: steps };
  }

  async tailscaleStatus(): Promise<{ ok: boolean; detail: string }> {
    try {
      const { stdout } = await run("tailscale", ["status"], {
        timeout: 8_000,
        encoding: "utf8",
      });
      const text = String(stdout);
      const hostShort = this.host.split(".")[0];
      const hostIp = this.host;
      const match = text.split("\n").find((line) => {
        const tokens = line.trim().split(/\s+/);
        return (
          tokens[0] === hostIp ||
          tokens[0] === hostShort ||
          tokens[1] === hostShort
        );
      });
      if (!match) {
        return {
          ok: false,
          detail: "Aparelho não encontrado na rede Tailscale",
        };
      }
      const active = match.includes("active");
      return {
        ok: active,
        detail: active
          ? "Conectado via tailnet"
          : "Aparelho offline na rede Tailscale",
      };
    } catch {
      return { ok: false, detail: "Não foi possível verificar o Tailscale" };
    }
  }
}
