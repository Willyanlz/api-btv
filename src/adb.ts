import { execFile } from "node:child_process";
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
    try {
      await this.execute(["connect", this.target]);
    } catch {
      // O estado detalhado abaixo produz uma mensagem mais útil que o stderr do connect.
    }
    const { stdout } = await this.execute(["devices", "-l"]);
    const line = String(stdout)
      .split("\n")
      .find((item) => item.startsWith(this.target));
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
    return {
      foreground:
        String(stdout)
          .split("\n")
          .find((line) => line.includes("mResumedActivity"))
          ?.trim() ?? null,
    };
  }

  async screenshot() {
    await this.ensureConnected();
    const { stdout } = await this.execute(
      ["-s", this.target, "exec-out", "screencap", "-p"],
      { encoding: null },
    );
    return Buffer.from(stdout as unknown as Uint8Array);
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
          tokens[0] === hostIp || tokens[0] === hostShort || tokens[1] === hostShort
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
