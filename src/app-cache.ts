import { AdbService, AppMetadata } from "./adb.js";
import { db, log } from "./db.js";

export interface CachedApp {
  packageName: string;
  name: string;
  hasIcon: boolean;
  icon: string;
  color: string;
}

interface CacheRow {
  package_name: string;
  name: string;
  icon_blob: Buffer | null;
  icon_mime_type: string | null;
}

const knownApps: Record<string, { name: string; icon: string; color: string }> =
  {
    "com.global.unitviptv": { name: "UniTV", icon: "bi-tv", color: "#4f7cff" },
    "com.netflix.ninja": {
      name: "Netflix",
      icon: "bi-badge-hd",
      color: "#e50914",
    },
    "com.stremio.one": {
      name: "Stremio",
      icon: "bi-play-circle",
      color: "#7b5cff",
    },
    "org.xbmc.kodi": { name: "Kodi", icon: "bi-diamond", color: "#17a7d6" },
    "com.spotify.tv.android": {
      name: "Spotify",
      icon: "bi-spotify",
      color: "#1db954",
    },
    "com.tailscale.ipn": {
      name: "Tailscale",
      icon: "bi-diagram-3",
      color: "#555b66",
    },
    "com.limelight": {
      name: "Moonlight",
      icon: "bi-moon-stars",
      color: "#32a852",
    },
    "tv.twitch.android.viewer": {
      name: "Twitch",
      icon: "bi-twitch",
      color: "#9146ff",
    },
    "com.google.android.apps.youtube.tv": {
      name: "YouTube",
      icon: "bi-youtube",
      color: "#ff0000",
    },
    "com.google.android.youtube": {
      name: "YouTube",
      icon: "bi-youtube",
      color: "#ff0000",
    },
    "com.globo.globotv": {
      name: "Globoplay",
      icon: "bi-play-btn",
      color: "#d40000",
    },
    "com.disney.disneyplus": {
      name: "Disney+",
      icon: "bi-stars",
      color: "#1f3d7d",
    },
    "tv.pluto.android": {
      name: "Pluto TV",
      icon: "bi-broadcast",
      color: "#f29100",
    },
    "com.plexapp.android": {
      name: "Plex",
      icon: "bi-collection-play",
      color: "#e5a00d",
    },
    "org.videolan.vlc": { name: "VLC", icon: "bi-play-btn", color: "#ff6d00" },
    "com.crunchyroll.crunchyroid": {
      name: "Crunchyroll",
      icon: "bi-film",
      color: "#f47521",
    },
    "com.hbo.hbomax": {
      name: "HBO Max",
      icon: "bi-badge-hd",
      color: "#46008c",
    },
    "com.paramount.plus": {
      name: "Paramount+",
      icon: "bi-play-circle",
      color: "#0f46b4",
    },
    "com.apple.atve.amp.tv": {
      name: "Apple TV",
      icon: "bi-apple",
      color: "#a1a1a6",
    },
    "com.mxtech.videoplayer.ad": {
      name: "MX Player",
      icon: "bi-collection-play",
      color: "#10af62",
    },
  };

const synchronizations = new Map<string, Promise<CachedApp[]>>();

function fallbackName(packageName: string) {
  return (
    knownApps[packageName]?.name ?? packageName.split(".").at(-1) ?? packageName
  );
}

function saveMetadata(
  deviceId: string,
  packageName: string,
  metadata: AppMetadata,
) {
  db.prepare(
    `INSERT INTO device_app_cache (
      device_id, package_name, name, icon_blob, icon_mime_type
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id, package_name) DO UPDATE SET
      name = excluded.name,
      icon_blob = excluded.icon_blob,
      icon_mime_type = excluded.icon_mime_type,
      updated_at = CURRENT_TIMESTAMP`,
  ).run(
    deviceId,
    packageName,
    metadata.name?.trim() || fallbackName(packageName),
    metadata.icon,
    metadata.iconMimeType,
  );
}

async function synchronize(
  deviceId: string,
  adb: AdbService,
): Promise<CachedApp[]> {
  const packages = await adb.listUserApps();
  const packageSet = new Set(packages);
  const cachedRows = db
    .prepare(
      `SELECT package_name, name, icon_blob, icon_mime_type
       FROM device_app_cache WHERE device_id = ?`,
    )
    .all(deviceId) as CacheRow[];
  const cachedPackages = new Set(cachedRows.map((row) => row.package_name));

  const remove = db.prepare(
    "DELETE FROM device_app_cache WHERE device_id = ? AND package_name = ?",
  );
  const removeTransaction = db.transaction((names: string[]) => {
    for (const packageName of names) remove.run(deviceId, packageName);
  });
  removeTransaction(
    cachedRows
      .map((row) => row.package_name)
      .filter((packageName) => !packageSet.has(packageName)),
  );

  const pendingPackages = packages.filter(
    (packageName) => !cachedPackages.has(packageName),
  );
  let pendingIndex = 0;
  const extractNext = async (): Promise<void> => {
    const packageName = pendingPackages[pendingIndex];
    pendingIndex += 1;
    if (!packageName) return;

    try {
      saveMetadata(
        deviceId,
        packageName,
        await adb.extractAppMetadata(packageName),
      );
    } catch (error) {
      saveMetadata(deviceId, packageName, {
        name: null,
        icon: null,
        iconMimeType: null,
      });
      log(
        `app-metadata:${packageName}`,
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
    await extractNext();
  };
  await Promise.all(
    Array.from({ length: Math.min(3, pendingPackages.length) }, () =>
      extractNext(),
    ),
  );

  const rows = db
    .prepare(
      `SELECT package_name, name, icon_blob, icon_mime_type
       FROM device_app_cache WHERE device_id = ? ORDER BY name`,
    )
    .all(deviceId) as CacheRow[];

  return rows.map((row) => ({
    packageName: row.package_name,
    name: row.name,
    hasIcon: Boolean(row.icon_blob && row.icon_mime_type),
    icon: knownApps[row.package_name]?.icon ?? "bi-app",
    color: knownApps[row.package_name]?.color ?? "#34465f",
  }));
}

export function synchronizeAppCache(deviceId: string, adb: AdbService) {
  const active = synchronizations.get(deviceId);
  if (active) return active;

  const operation = synchronize(deviceId, adb).finally(() => {
    synchronizations.delete(deviceId);
  });
  synchronizations.set(deviceId, operation);
  return operation;
}

export function getCachedIcon(deviceId: string, packageName: string) {
  return db
    .prepare(
      `SELECT icon_blob, icon_mime_type FROM device_app_cache
       WHERE device_id = ? AND package_name = ?`,
    )
    .get(deviceId, packageName) as
    | { icon_blob: Buffer | null; icon_mime_type: string | null }
    | undefined;
}

export function removeCachedApp(deviceId: string, packageName: string) {
  db.prepare(
    "DELETE FROM device_app_cache WHERE device_id = ? AND package_name = ?",
  ).run(deviceId, packageName);
}
