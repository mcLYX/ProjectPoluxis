import type { AlbumItem, SongItem, DifficultyEntry, BeatmapItem } from '../types/beatmap';
import { generateId, getLibrary, saveLibrary, deleteFile, storeFileDedup } from './idb';

const listeners = new Set<() => void>();
let libraryVersion = 0;

export function getLibraryVersion(): number {
  return libraryVersion;
}

export function onLibraryChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify() {
  libraryVersion += 1;
  listeners.forEach((l) => l());
}

export async function mutateLibrary(fn: (albums: AlbumItem[]) => AlbumItem[]): Promise<AlbumItem[]> {
  const current = await getLibrary();
  const next = fn(current);
  await saveLibrary(next);
  notify();
  return next;
}

export async function ensureDownloadsAlbum(): Promise<AlbumItem> {
  const albums = await getLibrary();
  const existing = albums.find((a) => a.id === 'downloads');
  if (existing) return existing;
  const downloads: AlbumItem = {
    type: 'album',
    id: 'downloads',
    title: 'Downloads',
    artist: '',
    cover: '',
    accentColor: '#f59e0b',
    basePath: '',
    songs: [],
  };
  await mutateLibrary((al) => [...al, downloads]);
  return downloads;
}

export async function createAlbum(partial?: Partial<AlbumItem>): Promise<AlbumItem> {
  const album: AlbumItem = {
    type: 'album',
    id: partial?.id ?? generateId('album'),
    title: partial?.title ?? '新专辑',
    artist: partial?.artist ?? '',
    cover: partial?.cover ?? '',
    accentColor: partial?.accentColor ?? '#22d3ee',
    basePath: '',
    songs: partial?.songs ?? [],
  };
  await mutateLibrary((al) => [...al, album]);
  return album;
}

export async function updateAlbum(id: string, patch: Partial<AlbumItem>): Promise<void> {
  await mutateLibrary((al) => al.map((a) => (a.id === id ? { ...a, ...patch } : a)));
}

export async function deleteAlbum(id: string): Promise<void> {
  const albums = await getLibrary();
  const album = findAlbumIn(albums, id);
  if (album) {
    const refs = collectRefs(album);
    // 专辑内的歌曲可能与其它专辑共享 idb:// 文件；仅删除不再被引用的文件。
    await deleteRefsSafely(refs, albums);
  }
  await mutateLibrary((al) => removeAlbumFromTree(al, id) as AlbumItem[]);
}

export async function addSong(albumId: string, song: SongItem): Promise<void> {
  await mutateLibrary((al) =>
    mapAlbumTree(al, albumId, (a) => ({ ...a, songs: [...a.songs, song] })) as AlbumItem[],
  );
}

/** 在库根目录直接创建一个独立曲目（不包装成专辑），与 moveSong 的根目录行为一致。 */
export async function addSongToRoot(song: SongItem): Promise<void> {
  await mutateLibrary((al) => [...al, song] as unknown as AlbumItem[]);
}

// ---- 以下为“按歌曲 id 在整树（含库根独立曲目）中定位并操作”的通用函数 ----
// 根目录独立曲目没有父专辑 id，所有依赖 albumId 的旧函数对它无效，故新增 id 维度版本。

/** 在整树（含库根）中按 id 找到歌曲节点。 */
export async function findSongById(songId: string): Promise<SongItem | null> {
  const albums = await getLibrary();
  const stack: BeatmapItem[] = [...albums];
  while (stack.length) {
    const it = stack.pop()!;
    if (it.type === 'song') {
      if (it.id === songId) return it;
    } else {
      stack.push(...it.songs);
    }
  }
  return null;
}

/** 递归把 id 匹配的歌曲应用 transform（兼容库根独立曲目与任意层级专辑内歌曲）。 */
function updateSongInTree(nodes: BeatmapItem[], songId: string, transform: (s: SongItem) => SongItem): BeatmapItem[] {
  return nodes.map((n) => {
    if (n.type === 'song') return n.id === songId ? transform(n) : n;
    return { ...n, songs: updateSongInTree(n.songs, songId, transform) };
  });
}

/** 按 id 更新歌曲（兼容库根独立曲目）。 */
export async function updateSongById(songId: string, patch: Partial<SongItem>): Promise<void> {
  await mutateLibrary(
    (al) => updateSongInTree(al as unknown as BeatmapItem[], songId, (s) => ({ ...s, ...patch })) as unknown as AlbumItem[],
  );
}

/** 按 id 删除歌曲（兼容库根独立曲目）。 */
export async function deleteSongById(songId: string): Promise<void> {
  await mutateLibrary((al) => deleteSongInTree(al as unknown as BeatmapItem[], songId) as unknown as AlbumItem[]);
}

function deleteSongInTree(nodes: BeatmapItem[], songId: string): BeatmapItem[] {
  return nodes
    .filter((n) => !(n.type === 'song' && n.id === songId))
    .map((n) => (n.type === 'album' ? { ...n, songs: deleteSongInTree(n.songs, songId) } : n));
}

/** 按 id 给歌曲新增一个难度（兼容库根独立曲目）。 */
export async function addDifficultyToSong(songId: string, diff: DifficultyEntry): Promise<void> {
  await mutateLibrary(
    (al) =>
      updateSongInTree(al as unknown as BeatmapItem[], songId, (s) => ({ ...s, difficulties: [...s.difficulties, diff] })) as unknown as AlbumItem[],
  );
}

/** 按 id + 难度名更新难度（兼容库根独立曲目）。 */
export async function updateDifficultyOfSong(
  songId: string,
  diffName: string,
  patch: Partial<DifficultyEntry>,
): Promise<void> {
  await mutateLibrary(
    (al) =>
      updateSongInTree(al as unknown as BeatmapItem[], songId, (s) => ({
        ...s,
        difficulties: s.difficulties.map((d) => (d.name === diffName ? { ...d, ...patch } : d)),
      })) as unknown as AlbumItem[],
  );
}

export async function updateSong(albumId: string, songId: string, patch: Partial<SongItem>): Promise<void> {
  await mutateLibrary((al) =>
    mapAlbumTree(al, albumId, (a) => ({
      ...a,
      songs: a.songs.map((s) => (s.type === 'song' && s.id === songId ? { ...s, ...patch } : s)),
    })) as AlbumItem[],
  );
}

export async function deleteSong(albumId: string, songId: string): Promise<void> {
  const albums = await getLibrary();
  const album = findAlbumIn(albums, albumId);
  const song = album?.songs.find((s) => s.type === 'song' && s.id === songId) as SongItem | undefined;
  if (song) {
    const refs = collectSongRefs(song);
    // 同一首歌可能以相同 id 出现在多个专辑，共享同一份 idb:// 文件；
    // 只有该引用不再被库内其它歌曲使用时才真正删除。
    await deleteRefsSafely(refs, albums, songId);
  }
  await mutateLibrary((al) =>
    mapAlbumTree(al, albumId, (a) => ({ ...a, songs: a.songs.filter((s) => s.id !== songId) })) as AlbumItem[],
  );
}

export async function addDifficulty(
  albumId: string,
  songId: string,
  diff: DifficultyEntry,
): Promise<void> {
  await mutateLibrary((al) =>
    mapAlbumTree(al, albumId, (a) => ({
      ...a,
      songs: a.songs.map((s) =>
        s.type === 'song' && s.id === songId ? { ...s, difficulties: [...s.difficulties, diff] } : s,
      ),
    })) as AlbumItem[],
  );
}

export async function updateDifficulty(
  albumId: string,
  songId: string,
  index: number,
  patch: Partial<DifficultyEntry>,
): Promise<void> {
  await mutateLibrary((al) =>
    mapAlbumTree(al, albumId, (a) => ({
      ...a,
      songs: a.songs.map((s) =>
        s.type === 'song' && s.id === songId
          ? { ...s, difficulties: s.difficulties.map((d, i) => (i === index ? { ...d, ...patch } : d)) }
          : s,
      ),
    })) as AlbumItem[],
  );
}

export async function deleteDifficulty(albumId: string, songId: string, index: number): Promise<void> {
  const albums = await getLibrary();
  const album = findAlbumIn(albums, albumId);
  const song = album?.songs.find((s) => s.type === 'song' && s.id === songId) as SongItem | undefined;
  const diff = song?.difficulties[index];
  if (diff?.chartFile?.startsWith('idb://')) {
    // 该难度谱面文件可能也被同一首歌的其它难度、或同名副本共享；
    // 仅当库内再无其它引用时才删除。
    const usage = countRefUsage(albums, songId);
    if ((usage.get(diff.chartFile) || 0) === 0) {
      await deleteFile(diff.chartFile.replace(/^idb:\/\//, ''));
    }
  }
  await mutateLibrary((al) =>
    mapAlbumTree(al, albumId, (a) => ({
      ...a,
      songs: a.songs.map((s) =>
        s.type === 'song' && s.id === songId
          ? { ...s, difficulties: s.difficulties.filter((_, i) => i !== index) }
          : s,
      ),
    })) as AlbumItem[],
  );
}

export async function addSongToDownloads(song: SongItem): Promise<void> {
  const downloads = await ensureDownloadsAlbum();
  await mutateLibrary((al) =>
    al.map((a) => {
      if (a.id !== 'downloads') return a;
      // 同一在线曲目重复下载时，更新已有副本而非新增，避免重复。
      if (song.onlineId) {
        const idx = a.songs.findIndex((s) => s.type === 'song' && (s as SongItem).onlineId === song.onlineId);
        if (idx >= 0) {
          const next = [...a.songs];
          next[idx] = song;
          return { ...a, songs: next };
        }
      }
      return { ...a, songs: [...a.songs, song] };
    }),
  );
  void downloads;
}

export async function getSongParentAlbumId(songId: string): Promise<string | null> {
  const albums = await getLibrary();
  const stack: AlbumItem[] = [...albums];
  while (stack.length) {
    const a = stack.pop()!;
    // 库根可能存在独立曲目（SongItem），跳过以免访问不存在的 songs
    if (a.type === 'album' && a.songs.some((s) => s.type === 'song' && s.id === songId)) return a.id;
    if (a.type === 'album') {
      a.songs.forEach((s) => {
        if (s.type === 'album') stack.push(s);
      });
    }
  }
  return null;
}

export async function getAlbumById(id: string): Promise<AlbumItem | null> {
  const albums = await getLibrary();
  const stack: AlbumItem[] = [...albums];
  while (stack.length) {
    const a = stack.pop()!;
    if (a.id === id) return a;
    if (a.type === 'album') {
      a.songs.forEach((s) => {
        if (s.type === 'album') stack.push(s);
      });
    }
  }
  return null;
}

function isDescendant(ancestor: AlbumItem, id: string): boolean {
  for (const s of ancestor.songs) {
    if (s.type === 'album') {
      if (s.id === id) return true;
      if (isDescendant(s, id)) return true;
    }
  }
  return false;
}

// 从同一份库中按 id 查找专辑（同步，确保返回的是被 saveLibrary 保存的那个实例）。
function findAlbumIn(nodes: BeatmapItem[], id: string): AlbumItem | null {
  for (const n of nodes) {
    if (n.type === 'album') {
      if (n.id === id) return n;
      const found = findAlbumIn(n.songs, id);
      if (found) return found;
    }
  }
  return null;
}

// 递归地对树中 id 匹配的专辑应用 transform。
function mapAlbumTree(
  nodes: BeatmapItem[],
  id: string,
  transform: (a: AlbumItem) => AlbumItem,
): BeatmapItem[] {
  return nodes.map((n) => {
    if (n.type === 'album') {
      const mapped = n.id === id ? transform(n) : n;
      return { ...mapped, songs: mapAlbumTree(mapped.songs, id, transform) };
    }
    return n;
  });
}

// 递归移除树中 id 匹配的专辑（含其子树）。
function removeAlbumFromTree(nodes: BeatmapItem[], id: string): BeatmapItem[] {
  const out: BeatmapItem[] = [];
  for (const n of nodes) {
    if (n.type === 'album') {
      if (n.id === id) continue;
      out.push({ ...n, songs: removeAlbumFromTree(n.songs, id) });
    } else {
      out.push(n);
    }
  }
  return out;
}

export async function moveSong(
  _fromAlbumId: string | null,
  toAlbumId: string | null,
  songId: string,
): Promise<void> {
  const albums = await getLibrary();
  let song: BeatmapItem | null = null;
  const extract = (arr: BeatmapItem[]): boolean => {
    for (let i = 0; i < arr.length; i++) {
      const node = arr[i];
      if (node.type === 'song' && node.id === songId) {
        song = node;
        arr.splice(i, 1);
        return true;
      }
      if (node.type === 'album' && extract(node.songs)) return true;
    }
    return false;
  };
  extract(albums);
  if (!song) return;
  if (toAlbumId) {
    // 同一实例定位目标专辑，避免 getAlbumById 返回脱节副本导致粘贴丢失。
    const target = findAlbumIn(albums, toAlbumId);
    if (target) {
      target.songs.push(song);
      await saveLibrary(albums);
      notify();
      return;
    }
  }
  // 根目录：作为独立曲目直接加入库根（不再包装成专辑）。
  (albums as unknown as BeatmapItem[]).push(song);
  await saveLibrary(albums);
  notify();
}

export async function moveAlbum(
  _fromAlbumId: string | null,
  toAlbumId: string | null,
  albumId: string,
): Promise<void> {
  if (toAlbumId === albumId) return;
  const albums = await getLibrary();
  let album: AlbumItem | null = null;
  const extract = (arr: BeatmapItem[]): boolean => {
    for (let i = 0; i < arr.length; i++) {
      const node = arr[i];
      if (node.type === 'album' && node.id === albumId) {
        album = node as AlbumItem;
        arr.splice(i, 1);
        return true;
      }
      if (node.type === 'album' && extract(node.songs)) return true;
    }
    return false;
  };
  extract(albums);
  if (!album) return;
  if (toAlbumId) {
    // 同一实例定位目标专辑，避免 getAlbumById 返回脱节副本导致粘贴丢失。
    const target = findAlbumIn(albums, toAlbumId);
    if (target && !isDescendant(album, toAlbumId)) {
      target.songs.push(album);
      await saveLibrary(albums);
      notify();
      return;
    }
  }
  albums.push(album);
  await saveLibrary(albums);
  notify();
}

async function fetchAndStoreLocal(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败: ${res.status}`);
  const blob = await res.blob();
  return storeFileDedup(blob);
}

export async function downloadSongToLibrary(song: SongItem): Promise<void> {
  const audioUrl = song.onlineUrls?.audio ?? song.audio;
  const coverUrl = song.onlineUrls?.cover ?? song.cover;
  const audioRef = audioUrl ? await fetchAndStoreLocal(audioUrl) : '';
  const coverRef = coverUrl ? await fetchAndStoreLocal(coverUrl) : '';
  const difficulties: DifficultyEntry[] = [];
  for (let i = 0; i < song.difficulties.length; i++) {
    const d = song.difficulties[i];
    const chartUrl = song.onlineUrls?.charts?.[i] ?? d.chartFile;
    const chartRef = chartUrl ? await fetchAndStoreLocal(chartUrl) : '';
    difficulties.push({ ...d, chartFile: chartRef });
  }
  // 记录在线来源，便于“重新下载”与去重。
  const onlineId = song.onlineId ?? song.id;
  const local: SongItem = {
    ...song,
    audio: audioRef,
    cover: coverRef,
    difficulties,
    source: 'local',
    onlineId,
    onlineUrls: {
      audio: (song.onlineUrls?.audio ?? song.audio) || undefined,
      cover: (song.onlineUrls?.cover ?? song.cover) || undefined,
      charts: song.difficulties.map((d, i) => song.onlineUrls?.charts?.[i] ?? d.chartFile),
    },
  };
  await addSongToDownloads(local);
}

export function collectSongRefs(song: SongItem): string[] {
  const refs: string[] = [];
  if (song.audio?.startsWith('idb://')) refs.push(song.audio.replace(/^idb:\/\//, ''));
  if (song.cover?.startsWith('idb://')) refs.push(song.cover.replace(/^idb:\/\//, ''));
  song.difficulties.forEach((d) => {
    if (d.chartFile?.startsWith('idb://')) refs.push(d.chartFile.replace(/^idb:\/\//, ''));
  });
  return refs;
}

export function collectRefs(album: AlbumItem): string[] {
  const refs: string[] = [];
  if (album.cover?.startsWith('idb://')) refs.push(album.cover.replace(/^idb:\/\//, ''));
  album.songs.forEach((s) => {
    if (s.type === 'song') refs.push(...collectSongRefs(s));
  });
  return refs;
}

// 统计整个库中每个 idb:// 引用被多少歌曲/难度使用（排除 exceptSongId）。
// 用于删除时判断是否“被其它同名歌曲副本共享”，避免误删共享文件。
function countRefUsage(albums: AlbumItem[], exceptSongId?: string): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (ref?: string) => {
    if (ref && ref.startsWith('idb://')) counts.set(ref, (counts.get(ref) || 0) + 1);
  };
  const walk = (nodes: BeatmapItem[]) => {
    for (const n of nodes) {
      if (n.type === 'album') walk(n.songs);
      else {
        if (n.id === exceptSongId) continue; // 跳过即将删除的歌曲自身
        bump(n.audio);
        bump(n.cover);
        n.difficulties.forEach((d) => bump(d.chartFile));
      }
    }
  };
  walk(albums);
  return counts;
}

// 仅删除“无其他引用”的文件（共享资源会被保留）。
async function deleteRefsSafely(refs: string[], albums: AlbumItem[], exceptSongId?: string): Promise<void> {
  if (!refs.length) return;
  const usage = countRefUsage(albums, exceptSongId);
  await Promise.all(
    refs.filter((r) => (usage.get(r) || 0) === 0).map((r) => deleteFile(r)),
  );
}
