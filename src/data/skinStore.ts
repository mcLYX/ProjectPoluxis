import { unzip } from 'fflate';
// 仅类型导入，避免把 three 拽入首屏主链；运行时按需动态 import('three')。
import type * as THREE from 'three';
import type { SkinMaps, SkinMeta, SkinTextureSet } from '../types/game';

/** Translation function injected by the caller (keeps this module React-free). */
type TFunc = (key: string, vars?: Record<string, string | number>) => string;
import {
  deleteFile,
  deleteSkin as dbDeleteSkin,
  generateId,
  getSkin as dbGetSkin,
  listSkins as dbListSkins,
  putSkin,
  resolveIdbUrl,
  storeFile,
} from './idb';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'];

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function mimeFromExt(ext: string): string {
  if (ext === 'svg') return 'image/svg+xml';
  if (IMAGE_EXT.includes(ext)) return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  return 'application/octet-stream';
}

interface SkinManifest {
  name?: unknown;
  author?: unknown;
  preview?: unknown;
  maps?: unknown;
}

/** Validate and normalise a parsed skin.json into a usable manifest. */
function normalizeManifest(raw: SkinManifest, t: TFunc): { name: string; author?: string; preview?: string; maps: SkinMaps } {
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    throw new Error(t('skin.error.noName'));
  }
  const mapsRaw = (raw.maps ?? {}) as Record<string, unknown>;
  const maps: SkinMaps = {};
  // Preserve every known map key — including the three per-note-type
  // projection guides (projTap/projTouch/projSlide) and the legacy shared
  // `projection`. Dropping the per-type keys would silently strip a skin's
  // custom projections, causing projection / hit-burst to fall back to the
  // default outline even though the skin is "active".
  for (const key of ['tap', 'touch', 'slide', 'projTap', 'projTouch', 'projSlide', 'projection'] as const) {
    const v = mapsRaw[key];
    if (typeof v === 'string' && v.trim()) maps[key] = v.trim();
  }
  if (Object.keys(maps).length === 0) {
    throw new Error(t('skin.error.noMaps'));
  }
  const preview = typeof raw.preview === 'string' && raw.preview.trim() ? raw.preview.trim() : undefined;
  return {
    name: raw.name.trim(),
    author: typeof raw.author === 'string' && raw.author.trim() ? raw.author.trim() : undefined,
    preview,
    maps,
  };
}

/** Import a skin ZIP: parse skin.json, store referenced images, persist meta. */
export async function importSkinZip(file: File, t: TFunc): Promise<SkinMeta> {
  if (extOf(file.name) !== 'zip') {
    throw new Error(t('skin.error.notZip'));
  }
  const buffer = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(buffer, (err, out) => (err ? reject(err) : resolve(out)));
  });

  // locate skin.json (case-insensitive, allow leading folders)
  const jsonKey = Object.keys(entries).find((k) => k.toLowerCase().split('/').pop() === 'skin.json');
  if (!jsonKey) {
    throw new Error(t('skin.error.noJson'));
  }
  let manifest: SkinManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(entries[jsonKey])) as SkinManifest;
  } catch {
    throw new Error(t('skin.error.badJson'));
  }
  const norm = normalizeManifest(manifest, t);

  // every referenced file must exist inside the zip and be an image
  const allRefs = [...Object.values(norm.maps), ...(norm.preview ? [norm.preview] : [])];
  const missing = allRefs.filter((ref) => !Object.keys(entries).some((k) => k === ref || k.endsWith('/' + ref)));
  if (missing.length) {
    throw new Error(`${t('skin.error.missingFile')} ${missing.join(', ')}`);
  }

  const storeImage = async (ref: string): Promise<string> => {
    const key = Object.keys(entries).find((k) => k === ref || k.endsWith('/' + ref))!;
    const ext = extOf(key);
    if (!IMAGE_EXT.includes(ext)) {
      throw new Error(`${t('skin.error.unsupportedImage')} ${key}`);
    }
    const blob = new File([entries[key] as unknown as BlobPart], key.split('/').pop()!, { type: mimeFromExt(ext) });
    return storeFile(blob);
  };

  const maps: SkinMaps = {};
  for (const key of Object.keys(norm.maps) as (keyof SkinMaps)[]) {
    maps[key] = await storeImage(norm.maps[key]!);
  }
  const preview = norm.preview ? await storeImage(norm.preview) : undefined;

  const meta: SkinMeta = {
    id: generateId(),
    name: norm.name,
    author: norm.author,
    createdAt: Date.now(),
    preview,
    maps,
  };
  await putSkin(meta);
  return meta;
}

export async function listSkins(): Promise<SkinMeta[]> {
  return dbListSkins();
}

export async function getSkin(id: string): Promise<SkinMeta | undefined> {
  return dbGetSkin(id);
}

/** Delete a skin and (cascade) the image files it referenced. */
export async function deleteSkin(id: string): Promise<void> {
  const skin = await dbGetSkin(id);
  if (!skin) return;
  const refs = [...Object.values(skin.maps), ...(skin.preview ? [skin.preview] : [])].filter(
    (r): r is string => typeof r === 'string',
  );
  for (const ref of refs) {
    try {
      await deleteFile(ref);
    } catch {
      /* ignore missing files */
    }
  }
  await dbDeleteSkin(id);
}

/** Rasterise an SVG (from an object URL) into a THREE.CanvasTexture so it can be
 *  tinted (color × map) and alpha-tested like a normal bitmap. Falls back to a
 *  256px square when the SVG declares no intrinsic size. */
async function loadSvgTexture(url: string): Promise<THREE.Texture> {
  const THREE = await import('three');
  return new Promise((resolve, reject) => {
    void (async () => {
      try {
        const resp = await fetch(url);
        let svg = await resp.text();
        // Derive a render size from width/height attrs, else viewBox, else default.
        const dim = svg.match(/<svg[^>]*\b(?:width|viewBox)=/i);
        let size = 256;
        if (dim) {
          const vb = svg.match(/viewBox=["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i);
          const wh = svg.match(/\bwidth=["']([\d.]+)/i);
          if (vb) size = Math.max(1, Math.round(parseFloat(vb[1])));
          else if (wh) size = Math.max(1, Math.round(parseFloat(wh[1])));
        }
        // Guarantee intrinsic size so the browser rasterises the SVG.
        if (!/\b(?:width|height)=/.test(svg)) {
          svg = svg.replace(/<svg/i, `<svg width="${size}" height="${size}"`);
        }
        const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        const img = new Image();
        img.onload = () => {
          const w = img.naturalWidth || size;
          const h = img.naturalHeight || size;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('svg canvas unavailable'));
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          const tex = new THREE.CanvasTexture(canvas);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
          resolve(tex);
        };
        img.onerror = () => reject(new Error('svg decode failed'));
        img.src = dataUrl;
      } catch (e) {
        reject(e);
      }
    })();
  });
}

/** Preload a skin's textures into THREE.Texture objects. Missing/failed maps are
 *  silently omitted so the caller can fall back to the default solid look. */
export async function loadSkinTextures(meta: SkinMeta | null | undefined): Promise<SkinTextureSet | null> {
  if (!meta) return null;
  const THREE = await import('three');
  const textureLoader = new THREE.TextureLoader();
  const loadOne = async (ref?: string): Promise<THREE.Texture | undefined> => {
    if (!ref) return undefined;
    try {
      const url = await resolveIdbUrl(ref);
      if (ref.toLowerCase().endsWith('.svg')) {
        return await loadSvgTexture(url);
      }
      const tex = await textureLoader.loadAsync(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    } catch {
      return undefined;
    }
  };
  const [tap, touch, slide, projTap, projTouch, projSlide, projection] = await Promise.all([
    loadOne(meta.maps.tap),
    loadOne(meta.maps.touch),
    loadOne(meta.maps.slide),
    loadOne(meta.maps.projTap),
    loadOne(meta.maps.projTouch),
    loadOne(meta.maps.projSlide),
    loadOne(meta.maps.projection),
  ]);
  const set: SkinTextureSet = {};
  if (tap) set.tap = tap;
  if (touch) set.touch = touch;
  if (slide) set.slide = slide;
  if (projTap) set.projTap = projTap;
  if (projTouch) set.projTouch = projTouch;
  if (projSlide) set.projSlide = projSlide;
  if (projection) set.projection = projection;
  return Object.keys(set).length ? set : null;
}
