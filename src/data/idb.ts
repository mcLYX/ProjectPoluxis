import type { AlbumItem } from '../types/beatmap';

const DB_NAME = 'poluxis-filemanager';
const DB_VERSION = 1;
const STORE_FILES = 'files';
const STORE_LIBRARY = 'library';

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
