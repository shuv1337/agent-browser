const DEFAULT_HOSTNAME = "localhost";

function getHostname(): string {
  if (typeof window === "undefined") return DEFAULT_HOSTNAME;
  return window.location.hostname || DEFAULT_HOSTNAME;
}

function getProtocol(): string {
  if (typeof window === "undefined") return "http:";
  return window.location.protocol || "http:";
}

export function httpUrl(port: number): string {
  return `${getProtocol()}//${getHostname()}:${port}`;
}

export function wsUrl(port: number): string {
  const protocol = getProtocol() === "https:" ? "wss:" : "ws:";
  return `${protocol}//${getHostname()}:${port}`;
}
