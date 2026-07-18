export type SupportedProxyProtocol = "http:" | "https:";
export type StoredProxyProtocol = SupportedProxyProtocol | "socks:" | "socks4:" | "socks5:";

export interface ParsedProxyUrl {
  protocol: StoredProxyProtocol;
  hostname: string;
  port: string;
  username: string;
  password: string;
  supported: boolean;
}

const MAX_PROXY_URL_CHARS = 2_048;
const SUPPORTED_PROTOCOLS = new Set<StoredProxyProtocol>(["http:", "https:"]);
const LEGACY_SOCKS_PROTOCOLS = new Set<StoredProxyProtocol>(["socks:", "socks4:", "socks5:"]);

function decodeCredential(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("Proxy credentials must use valid URL encoding");
  }
}

function assertStoredProtocol(value: string): asserts value is StoredProxyProtocol {
  if (!SUPPORTED_PROTOCOLS.has(value as StoredProxyProtocol) && !LEGACY_SOCKS_PROTOCOLS.has(value as StoredProxyProtocol)) {
    throw new Error("Proxy URL must use HTTP or HTTPS");
  }
}

export function parseProxyUrl(value: string, allowLegacySocks = false): ParsedProxyUrl | null {
  const input = value.trim();
  if (!input) {
    return null;
  }
  if (input.length > MAX_PROXY_URL_CHARS) {
    throw new Error(`Proxy URL must not exceed ${MAX_PROXY_URL_CHARS} characters`);
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Proxy URL is invalid");
  }

  const protocol = url.protocol.toLowerCase();
  assertStoredProtocol(protocol);
  const supported = SUPPORTED_PROTOCOLS.has(protocol);
  if (!supported && !allowLegacySocks) {
    throw new Error("Proxy URL must use HTTP or HTTPS");
  }
  if (!url.hostname) {
    throw new Error("Proxy URL must include a hostname");
  }
  if (url.pathname && url.pathname !== "/") {
    throw new Error("Proxy URL must not include a path");
  }
  if (url.search) {
    throw new Error("Proxy URL must not include a query");
  }
  if (url.hash) {
    throw new Error("Proxy URL must not include a fragment");
  }

  return {
    protocol,
    hostname: url.hostname.toLowerCase(),
    port: url.port,
    username: decodeCredential(url.username),
    password: decodeCredential(url.password),
    supported
  };
}

function createProxyUrl(proxy: Omit<ParsedProxyUrl, "password">, password = "") {
  assertStoredProtocol(proxy.protocol);
  const url = new URL(`${proxy.protocol}//${proxy.hostname}`);
  if (proxy.port) {
    url.port = proxy.port;
  }
  if (proxy.username) {
    url.username = proxy.username;
  }
  if (password) {
    url.password = password;
  }
  return url;
}

function serializeProxyUrl(url: URL) {
  return url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
}

export function formatProxyUrl(proxy: Omit<ParsedProxyUrl, "password">, password = ""): string {
  if (!proxy.supported || !SUPPORTED_PROTOCOLS.has(proxy.protocol)) {
    throw new Error("Cannot use an unsupported proxy protocol at runtime");
  }
  return serializeProxyUrl(createProxyUrl(proxy, password));
}

export function formatPublicProxyUrl(proxy: Omit<ParsedProxyUrl, "password">): string {
  return serializeProxyUrl(createProxyUrl({ ...proxy, username: "" }));
}

export function redactProxyCredentials(value: string): string {
  return value.replace(
    /\b((?:https?|socks(?:4|5)?):\/\/[^@\s]*?):([^@\s]*)@/giu,
    "$1:***@"
  );
}
