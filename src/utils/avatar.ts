/**
 * 头像处理工具。
 *
 * 上传即「居中裁剪 + 压缩」为固定边长的方形，避免把大图原样塞进 IndexedDB。
 * 存储沿用皮肤贴图同一套范式：`storeFile` → `idb://…` 引用 → `resolveIdbUrl` 取 blob URL。
 */
import { deleteFile, storeFile } from '../data/idb';

/** 头像输出边长（像素）。 */
export const AVATAR_SIZE = 256;

/** 允许上传的原始文件体积上限。 */
export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

/** 校验失败原因；`null` 表示文件可用。 */
export type AvatarReject = 'notImage' | 'tooLarge' | null;

/** 校验待上传的头像文件。 */
export function validateAvatarFile(file: File): AvatarReject {
  if (!file.type || !file.type.startsWith('image/')) return 'notImage';
  if (file.size > MAX_AVATAR_BYTES) return 'tooLarge';
  return null;
}

/** 是否为 IndexedDB 引用（可安全回收）。 */
export function isAvatarRef(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.startsWith('idb://');
}

/** 是否为可直接用于 <img src> 的远端地址（由平台账号提供）。 */
export function isRemoteAvatar(v: string | null | undefined): v is string {
  return typeof v === 'string' && /^https?:\/\//i.test(v);
}

function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('avatar decode failed'));
    };
    img.src = url;
  });
}

/** 居中裁剪并压缩为 `AVATAR_SIZE` 见方的 PNG。解码/编码失败时回退为原文件。 */
export async function processAvatarFile(file: File): Promise<Blob> {
  const src = await loadBitmap(file);
  const w = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
  const h = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
  const side = Math.max(1, Math.min(w, h));
  const sx = (w - side) / 2;
  const sy = (h - side) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src as CanvasImageSource, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

  return await new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b ?? file), 'image/png');
  });
}

/** 处理并持久化一张头像，返回 `idb://…` 引用。 */
export async function storeAvatar(file: File): Promise<string> {
  const processed = await processAvatarFile(file);
  return storeFile(processed);
}

/** 回收一个头像引用（仅 `idb://` 引用可被删除，远端地址忽略）。 */
export async function deleteAvatarRef(ref: string | null | undefined): Promise<void> {
  if (!isAvatarRef(ref)) return;
  await deleteFile(ref.replace(/^idb:\/\//, ''));
}
