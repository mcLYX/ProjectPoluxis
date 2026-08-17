export interface OnlineServer {
  id: string;
  label: string;
  baseUrl: string;
  /** fixed = the deployment that serves this app (the browser's own origin).
   *  It is derived from `location` and cannot be added/edited/removed. */
  fixed?: boolean;
}

const KEY_USER_SERVERS = 'poluxis.userServers';
const KEY_CURRENT = 'poluxis.currentServerId';

export const CURRENT_SERVER_ID = 'current';

/**
 * Normalize a beatmaps base URL: trim whitespace, auto-prepend `http://` when the
 * user typed a host without a protocol (e.g. `example.com` or `example.com:8080`),
 * strip the FQDN trailing dot (some deployments expose the host as `host.:port`,
 * i.e. a dot right before `/` or the end of the URL) which makes `fetch` reject
 * the URL, and strip trailing slashes. Protocol-relative (`//host`) and already
 * protocol-bearing URLs are left untouched.
 */
function normalizeBaseUrl(url: string): string {
  let u = url.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u) && !u.startsWith('//')) {
    u = `http://${u}`;
  }
  return u
    .replace(/\.+(?=\/|$)/g, '')
    .replace(/\/+$/, '');
}

/**
 * The beatmaps directory served by the SAME deployment that is hosting this app.
 * For a full install at http://polux.is this resolves to http://polux.is/beatmaps,
 * and for `vite dev` it resolves to http://localhost:5173/beatmaps — i.e. the
 * index lives at <baseUrl>/beatmaps.json and all paths inside it are relative to
 * <baseUrl>.
 *
 * BASE_URL is resolved against the CURRENT page URL (`location.href`) instead of
 * being naively concatenated to `location.origin`. The project's vite config uses
 * a relative base `'./'`, so under a subdirectory deployment (e.g. the app served
 * at https://site.com/poluxis/ with index.html inside that folder) the beatmaps
 * directory correctly becomes https://site.com/poluxis/beatmaps — NOT the site
 * root. An absolute base like '/poluxis/' (or '/') is used as-is.
 */
function currentServerBaseUrl(): string {
  const base = import.meta.env.BASE_URL || '/';
  let root: string;
  try {
    root = new URL(base, location.href).href;
  } catch {
    // Defensive fallback: absolute base string against the origin.
    root = `${location.origin}${base.replace(/\/+$/, '')}`;
  }
  return normalizeBaseUrl(`${root.replace(/\/+$/, '')}/beatmaps`);
}

export function makeCurrentServer(): OnlineServer {
  return {
    id: CURRENT_SERVER_ID,
    label: location.host || '本机服务器',
    baseUrl: currentServerBaseUrl(),
    fixed: true,
  };
}

function readUserServers(): OnlineServer[] {
  try {
    const raw = localStorage.getItem(KEY_USER_SERVERS);
    if (raw) {
      const parsed = JSON.parse(raw) as OnlineServer[];
      if (Array.isArray(parsed)) {
        return parsed
          .filter((s) => s && s.id !== CURRENT_SERVER_ID)
          .map((s) => ({ ...s, baseUrl: normalizeBaseUrl(s.baseUrl) }));
      }
    }
  } catch (e) {
    console.error('读取在线服务器失败', e);
  }
  return [];
}

function writeUserServers(servers: OnlineServer[]): void {
  localStorage.setItem(KEY_USER_SERVERS, JSON.stringify(servers));
}

const listeners = new Set<() => void>();

export function onServersChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify() {
  listeners.forEach((l) => l());
}

/** All known servers, with the current deployment always first. */
export function getServers(): OnlineServer[] {
  return [makeCurrentServer(), ...readUserServers()];
}

export function getServer(id: string): OnlineServer | null {
  return getServers().find((s) => s.id === id) ?? null;
}

export function addServer(label: string, baseUrl: string): OnlineServer {
  const cleanUrl = normalizeBaseUrl(baseUrl);
  let host = cleanUrl;
  try {
    host = new URL(cleanUrl).hostname;
  } catch {
    /* keep raw url as fallback */
  }
  const server: OnlineServer = {
    id: `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: label.trim() || host,
    baseUrl: cleanUrl,
  };
  const all = readUserServers();
  all.push(server);
  writeUserServers(all);
  notify();
  return server;
}

/** User servers only — the fixed server is derived and cannot be edited. */
export function updateServer(id: string, patch: Partial<Omit<OnlineServer, 'id'>>): void {
  const all = readUserServers().map((s) =>
    s.id === id
      ? { ...s, ...patch, baseUrl: patch.baseUrl ? normalizeBaseUrl(patch.baseUrl) : s.baseUrl }
      : s,
  );
  writeUserServers(all);
  notify();
}

/** The fixed (current-deployment) server can never be removed. */
export function removeServer(id: string): void {
  if (id === CURRENT_SERVER_ID) return;
  const all = readUserServers().filter((s) => s.id !== id);
  writeUserServers(all);
  if (getCurrentServer()?.id === id) {
    localStorage.setItem(KEY_CURRENT, CURRENT_SERVER_ID);
  }
  notify();
}

export function getCurrentServer(): OnlineServer {
  const all = getServers();
  const current = localStorage.getItem(KEY_CURRENT);
  return all.find((s) => s.id === current) ?? all[0];
}

export function setCurrentServer(id: string): void {
  localStorage.setItem(KEY_CURRENT, id);
  notify();
}
