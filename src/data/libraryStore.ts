import type { AlbumItem, SongItem, DifficultyEntry } from '../types/beatmap';
import { generateId, getLibrary, saveLibrary, deleteFile } from './idb';

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
  const album = albums.find((a) => a.id === id);
  if (album) {
    const refs = collectRefs(album);
    await Promise.all(refs.map((r) => deleteFile(r)));
  }
  await mutateLibrary((al) => al.filter((a) => a.id !== id));
}

export async function addSong(albumId: string, song: SongItem): Promise<void> {
  await mutateLibrary((al) =>
    al.map((a) => (a.id === albumId ? { ...a, songs: [...a.songs, song] } : a)),
  );
}

export async function updateSong(albumId: string, songId: string, patch: Partial<SongItem>): Promise<void> {
  await mutateLibrary((al) =>
    al.map((a) =>
      a.id === albumId
        ? {
            ...a,
            songs: a.songs.map((s) =>
              s.type === 'song' && s.id === songId ? { ...s, ...patch } : s,
            ),
          }
        : a,
    ),
  );
}

export async function deleteSong(albumId: string, songId: string): Promise<void> {
  const albums = await getLibrary();
  const album = albums.find((a) => a.id === albumId);
  const song = album?.songs.find((s) => s.type === 'song' && s.id === songId) as SongItem | undefined;
  if (song) {
    const refs = collectSongRefs(song);
    await Promise.all(refs.map((r) => deleteFile(r)));
  }
  await mutateLibrary((al) =>
    al.map((a) => (a.id === albumId ? { ...a, songs: a.songs.filter((s) => s.id !== songId) } : a)),
  );
}

export async function addDifficulty(
  albumId: string,
  songId: string,
  diff: DifficultyEntry,
): Promise<void> {
  await mutateLibrary((al) =>
    al.map((a) =>
      a.id === albumId
        ? {
            ...a,
            songs: a.songs.map((s) =>
              s.type === 'song' && s.id === songId
                ? { ...s, difficulties: [...s.difficulties, diff] }
                : s,
            ),
          }
        : a,
    ),
  );
}

export async function updateDifficulty(
  albumId: string,
  songId: string,
  index: number,
  patch: Partial<DifficultyEntry>,
): Promise<void> {
  await mutateLibrary((al) =>
    al.map((a) =>
      a.id === albumId
        ? {
            ...a,
            songs: a.songs.map((s) =>
              s.type === 'song' && s.id === songId
                ? {
                    ...s,
                    difficulties: s.difficulties.map((d, i) => (i === index ? { ...d, ...patch } : d)),
                  }
                : s,
            ),
          }
        : a,
    ),
  );
}

export async function deleteDifficulty(albumId: string, songId: string, index: number): Promise<void> {
  const albums = await getLibrary();
  const album = albums.find((a) => a.id === albumId);
  const song = album?.songs.find((s) => s.type === 'song' && s.id === songId) as SongItem | undefined;
  const diff = song?.difficulties[index];
  if (diff?.chartFile?.startsWith('idb://')) {
    await deleteFile(diff.chartFile.replace(/^idb:\/\//, ''));
  }
  await mutateLibrary((al) =>
    al.map((a) =>
      a.id === albumId
        ? {
            ...a,
            songs: a.songs.map((s) =>
              s.type === 'song' && s.id === songId
                ? { ...s, difficulties: s.difficulties.filter((_, i) => i !== index) }
                : s,
            ),
          }
        : a,
    ),
  );
}

export async function addSongToDownloads(song: SongItem): Promise<void> {
  const downloads = await ensureDownloadsAlbum();
  await mutateLibrary((al) =>
    al.map((a) => (a.id === 'downloads' ? { ...a, songs: [...a.songs, song] } : a)),
  );
  void downloads;
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
