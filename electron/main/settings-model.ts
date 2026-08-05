import type { AppSettings, AppSettingsUpdate } from "../shared/ipc-contracts.js";
import {
  formatProxyUrl,
  formatPublicProxyUrl,
  parseProxyUrl,
  type ParsedProxyUrl,
  type StoredProxyProtocol
} from "../shared/proxy-security.js";

export interface SettingsCrypto {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface StoredAppSettings {
  cacheMessages: boolean;
  cacheBodies: boolean;
  batchConcurrency: number;
  hotmailFallbackEnabled: boolean;
  autoRefreshEnabled: boolean;
  autoRefreshIntervalMinutes: number;
}

export interface SettingsFileV2 {
  version: 2;
  settings: StoredAppSettings;
  proxy: null | {
    protocol: StoredProxyProtocol;
    hostname: string;
    port: string;
    username: string;
    encryptedPassword: string;
  };
}

export interface RuntimeAppSettings extends StoredAppSettings {
  proxyUrl: string;
}

const DEFAULT_SETTINGS: StoredAppSettings = {
  cacheMessages: true,
  cacheBodies: true,
  batchConcurrency: 4,
  hotmailFallbackEnabled: true,
  autoRefreshEnabled: false,
  autoRefreshIntervalMinutes: 10
};

const STORED_PROXY_PROTOCOLS = new Set<StoredProxyProtocol>([
  "http:",
  "https:",
  "socks:",
  "socks4:",
  "socks5:"
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(Math.max(Math.round(numeric), minimum), maximum)
    : fallback;
}

function normalizeStoredSettings(value: unknown): StoredAppSettings {
  const input = asRecord(value) ?? {};
  return {
    cacheMessages: input.cacheMessages !== false,
    cacheBodies: input.cacheBodies !== false,
    batchConcurrency: boundedInteger(input.batchConcurrency, DEFAULT_SETTINGS.batchConcurrency, 1, 12),
    hotmailFallbackEnabled:
      typeof input.hotmailFallbackEnabled === "boolean"
        ? input.hotmailFallbackEnabled
        : input.hotmailHelperFallbackEnabled !== false,
    autoRefreshEnabled: input.autoRefreshEnabled === true,
    autoRefreshIntervalMinutes: boundedInteger(
      input.autoRefreshIntervalMinutes,
      DEFAULT_SETTINGS.autoRefreshIntervalMinutes,
      1,
      120
    )
  };
}

function proxyDescriptor(
  proxy: SettingsFileV2["proxy"]
): Omit<ParsedProxyUrl, "password"> | null {
  if (!proxy) {
    return null;
  }
  return {
    protocol: proxy.protocol,
    hostname: proxy.hostname,
    port: proxy.port,
    username: proxy.username,
    supported: proxy.protocol === "http:" || proxy.protocol === "https:"
  };
}

function normalizeV2Proxy(value: unknown): SettingsFileV2["proxy"] {
  if (value === null || value === undefined) {
    return null;
  }

  const input = asRecord(value);
  if (!input) {
    throw new Error("Settings proxy entry is invalid");
  }
  if (Object.keys(input).some((key) => !["protocol", "hostname", "port", "username", "encryptedPassword"].includes(key))) {
    throw new Error("Settings proxy entry contains unsupported fields");
  }
  if (typeof input.protocol !== "string" || !STORED_PROXY_PROTOCOLS.has(input.protocol as StoredProxyProtocol)) {
    throw new Error("Settings proxy protocol is invalid");
  }
  if (typeof input.hostname !== "string" || !input.hostname.trim() || input.hostname.length > 255) {
    throw new Error("Settings proxy hostname is invalid");
  }
  if (typeof input.port !== "string" || !/^\d{0,5}$/u.test(input.port)) {
    throw new Error("Settings proxy port is invalid");
  }
  if (typeof input.username !== "string" || input.username.length > 256) {
    throw new Error("Settings proxy username is invalid");
  }
  if (typeof input.encryptedPassword !== "string" || input.encryptedPassword.length > 16_384) {
    throw new Error("Settings proxy password entry is invalid");
  }

  const protocol = input.protocol as StoredProxyProtocol;
  const parsed = parseProxyUrl(
    `${protocol}//${input.hostname.trim()}${input.port ? `:${input.port}` : ""}`,
    true
  );
  if (!parsed) {
    throw new Error("Settings proxy entry is invalid");
  }

  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    username: input.username,
    encryptedPassword: input.encryptedPassword
  };
}

function normalizeV2File(value: unknown): SettingsFileV2 {
  const input = asRecord(value);
  if (!input || input.version !== 2) {
    throw new Error("Settings file version 2 is invalid");
  }
  return {
    version: 2,
    settings: normalizeStoredSettings(input.settings),
    proxy: normalizeV2Proxy(input.proxy)
  };
}

function migrateLegacyProxy(value: unknown, crypto: SettingsCrypto): SettingsFileV2["proxy"] {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = parseProxyUrl(value, true);
  if (!parsed) {
    return null;
  }
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    username: parsed.username,
    encryptedPassword: parsed.password ? crypto.encrypt(parsed.password) : ""
  };
}

export function createDefaultSettingsFile(): SettingsFileV2 {
  return {
    version: 2,
    settings: { ...DEFAULT_SETTINGS },
    proxy: null
  };
}

export function migrateSettingsFile(
  value: unknown,
  crypto: SettingsCrypto
): { file: SettingsFileV2; migrated: boolean } {
  const input = asRecord(value);
  if (!input) {
    return { file: createDefaultSettingsFile(), migrated: false };
  }
  if (input.version === 2) {
    return { file: normalizeV2File(input), migrated: false };
  }

  const legacySettings = asRecord(input.settings);
  if (!legacySettings) {
    return { file: createDefaultSettingsFile(), migrated: false };
  }
  return {
    file: {
      version: 2,
      settings: normalizeStoredSettings(legacySettings),
      proxy: migrateLegacyProxy(legacySettings.proxyUrl, crypto)
    },
    migrated: true
  };
}

export function projectPublicSettings(file: SettingsFileV2): AppSettings {
  const normalized = normalizeV2File(file);
  const proxy = proxyDescriptor(normalized.proxy);
  return {
    ...normalized.settings,
    proxyUrl: proxy ? formatPublicProxyUrl(proxy) : "",
    proxyUsername: normalized.proxy?.username ?? "",
    proxyHasPassword: Boolean(normalized.proxy?.encryptedPassword),
    proxySupported: proxy?.supported ?? true
  };
}

export function projectRuntimeSettings(file: SettingsFileV2, crypto: SettingsCrypto): RuntimeAppSettings {
  const normalized = normalizeV2File(file);
  const proxy = proxyDescriptor(normalized.proxy);
  if (!proxy) {
    return { ...normalized.settings, proxyUrl: "" };
  }
  if (!proxy.supported) {
    throw new Error("代理协议不受支持；仅支持 HTTP/HTTPS，请在设置中修正或清空代理。");
  }

  const password = normalized.proxy?.encryptedPassword
    ? crypto.decrypt(normalized.proxy.encryptedPassword)
    : "";
  return {
    ...normalized.settings,
    proxyUrl: formatProxyUrl(proxy, password)
  };
}

function sameEndpoint(left: SettingsFileV2["proxy"], right: SettingsFileV2["proxy"]) {
  if (!left || !right) {
    return left === right;
  }
  return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port;
}

export function applySettingsUpdate(
  file: SettingsFileV2,
  update: AppSettingsUpdate,
  crypto: SettingsCrypto
): { file: SettingsFileV2; proxyChanged: boolean } {
  const current = normalizeV2File(file);
  const settings = normalizeStoredSettings({ ...current.settings, ...update });
  const hasProxyUrl = Object.prototype.hasOwnProperty.call(update, "proxyUrl");
  const hasProxyUsername = Object.prototype.hasOwnProperty.call(update, "proxyUsername");
  const hasProxyPassword = Object.prototype.hasOwnProperty.call(update, "proxyPassword");

  let nextProxy = current.proxy ? { ...current.proxy } : null;
  if (hasProxyUrl) {
    const parsed = parseProxyUrl(update.proxyUrl ?? "");
    if (!parsed) {
      if ((update.proxyUsername ?? "").trim() || update.proxyPassword) {
        throw new Error("Direct mode cannot store proxy credentials");
      }
      nextProxy = null;
    } else {
      if (parsed.username || parsed.password) {
        throw new Error("Proxy credentials must use the separate username and password fields");
      }
      nextProxy = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        username: hasProxyUsername ? (update.proxyUsername ?? "").trim() : current.proxy?.username ?? "",
        encryptedPassword: current.proxy?.encryptedPassword ?? ""
      };
    }
  } else if (hasProxyUsername) {
    if (!nextProxy) {
      if ((update.proxyUsername ?? "").trim()) {
        throw new Error("Proxy username requires a proxy endpoint");
      }
    } else {
      nextProxy.username = (update.proxyUsername ?? "").trim();
    }
  }

  if (!nextProxy) {
    if (hasProxyPassword && update.proxyPassword) {
      throw new Error("Proxy password requires a proxy endpoint");
    }
    const nextFile = { version: 2, settings, proxy: null } satisfies SettingsFileV2;
    return { file: nextFile, proxyChanged: current.proxy !== null };
  }

  const endpointChanged = !sameEndpoint(current.proxy, nextProxy);
  const usernameChanged = (current.proxy?.username ?? "") !== nextProxy.username;
  let passwordChanged = false;
  if (update.clearProxyPassword === true) {
    passwordChanged = Boolean(current.proxy?.encryptedPassword);
    nextProxy.encryptedPassword = "";
  } else if (hasProxyPassword && update.proxyPassword) {
    try {
      const currentPassword = current.proxy?.encryptedPassword
        ? crypto.decrypt(current.proxy.encryptedPassword)
        : "";
      passwordChanged = currentPassword !== update.proxyPassword;
    } catch {
      passwordChanged = true;
    }
    nextProxy.encryptedPassword = crypto.encrypt(update.proxyPassword);
  } else if (endpointChanged || usernameChanged) {
    nextProxy.encryptedPassword = "";
  }

  const proxyChanged = endpointChanged || usernameChanged || passwordChanged;
  return {
    file: { version: 2, settings, proxy: nextProxy },
    proxyChanged
  };
}
