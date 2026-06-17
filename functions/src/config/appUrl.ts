const DEFAULT_APP_URL = "https://careconnex-d4c8b.web.app";

export function getAppUrl(): string {
  const raw = (process.env.APP_URL ?? "").trim();
  return (raw || DEFAULT_APP_URL).replace(/\/+$/, "");
}

export function appLink(path = ""): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${getAppUrl()}${normalized}`;
}
