import type { AlbumItem } from '../types/beatmap';
import type { SkinMeta } from '../types/game';

const DB_NAME = 'poluxis-filemanager';
const DB_VERSION = 3;
const STORE_FILES = 'files';
const STORE_LIBRARY = 'library';
const STORE_HASHES = 'fileHashes';
const STORE_SKINS = 'skins';

export interface StoredFile {
  id: string;
  blob: Blob;
  mime: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_LIBRARY)) {
        db.createObjectStore(STORE_LIBRARY, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_HASHES)) {
        db.createObjectStore(STORE_HASHES, { keyPath: 'hash' });
      }
      if (!db.objectStoreNames.contains(STORE_SKINS)) {
        db.createObjectStore(STORE_SKINS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export function generateId(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function putFile(id: string, blob: Blob, mime = blob.type || 'application/octet-stream'): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_FILES, 'readwrite');
    t.objectStore(STORE_FILES).put({ id, blob, mime });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getFile(id: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_FILES, 'readonly');
    const r = t.objectStore(STORE_FILES).get(id);
    r.onsuccess = () => resolve((r.result as StoredFile | undefined)?.blob ?? null);
    r.onerror = () => reject(r.error);
  });
}

export async function deleteFile(id: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_FILES, 'readwrite');
    t.objectStore(STORE_FILES).delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---- Object URL cache (idb://<fileId> -> blob: URL) ----
export const idbUrlCache: Map<string, string> = new Map();

export function getCachedIdbUrl(fileId: string): string | null {
  return idbUrlCache.get(fileId) ?? null;
}

export async function resolveIdbUrl(ref: string): Promise<string> {
  const fileId = ref.replace(/^idb:\/\//, '');
  const cached = idbUrlCache.get(fileId);
  if (cached) return cached;
  const blob = await getFile(fileId);
  if (!blob) return ref;
  const url = URL.createObjectURL(blob);
  idbUrlCache.set(fileId, url);
  return url;
}

export async function preloadIdbUrls(refs: string[]): Promise<void> {
  await Promise.all(refs.map((r) => resolveIdbUrl(r).catch(() => null)));
}

// Store a File/Blob and return an idb:// reference usable in beatmap fields.
export async function storeFile(file: Blob): Promise<string> {
  const id = generateId('file');
  await putFile(id, file as Blob, (file as File).type || 'application/octet-stream');
  return `idb://${id}`;
}

// ---- Content-hash dedup index ----
// Maps a SHA-256 of file bytes to an existing idb:// reference so identical
// files (e.g. the same audio reused across songs, or re-imports) are stored once.
async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getHashRef(hash: string): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_HASHES, 'readonly');
    const r = t.objectStore(STORE_HASHES).get(hash);
    r.onsuccess = () => resolve((r.result as { ref?: string } | undefined)?.ref ?? null);
    r.onerror = () => reject(r.error);
  });
}

async function putHashRef(hash: string, ref: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_HASHES, 'readwrite');
    t.objectStore(STORE_HASHES).put({ hash, ref });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** Store a blob, reusing an existing idb:// ref if identical content was stored before. */
export async function storeFileDedup(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await sha256Hex(buf);
  const existing = await getHashRef(hash);
  if (existing) return existing;
  const ref = await storeFile(new Blob([buf], { type: file.type || 'application/octet-stream' }));
  await putHashRef(hash, ref);
  return ref;
}

// ---- Library (local album list) ----
export async function saveLibrary(albums: AlbumItem[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_LIBRARY, 'readwrite');
    t.objectStore(STORE_LIBRARY).put({ key: 'localLibrary', value: albums });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getLibrary(): Promise<AlbumItem[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_LIBRARY, 'readonly');
    const r = t.objectStore(STORE_LIBRARY).get('localLibrary');
    r.onsuccess = () => resolve((r.result as { value?: AlbumItem[] } | undefined)?.value ?? []);
    r.onerror = () => reject(r.error);
  });
}

// ---------- Skins store ----------

export async function putSkin(meta: SkinMeta): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_SKINS, 'readwrite');
    t.objectStore(STORE_SKINS).put(meta);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getSkin(id: string): Promise<SkinMeta | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_SKINS, 'readonly');
    const r = t.objectStore(STORE_SKINS).get(id);
    r.onsuccess = () => resolve(r.result as SkinMeta | undefined);
    r.onerror = () => reject(r.error);
  });
}

export async function listSkins(): Promise<SkinMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_SKINS, 'readonly');
    const r = t.objectStore(STORE_SKINS).getAll();
    r.onsuccess = () => {
      const list = ((r.result as SkinMeta[] | undefined) ?? []).sort((a, b) => b.createdAt - a.createdAt);
      resolve(list);
    };
    r.onerror = () => reject(r.error);
  });
}

export async function deleteSkin(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_SKINS, 'readwrite');
    t.objectStore(STORE_SKINS).delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
