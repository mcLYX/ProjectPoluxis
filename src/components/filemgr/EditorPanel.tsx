import { useState, useEffect, useRef } from 'react';
import { useI18n } from '../../i18n';
import type { AlbumItem, SongItem, DifficultyEntry } from '../../types/beatmap';
import type { ChartData } from '../../types/game';
import { FileField, Field, Selection } from './shared';
import { generateId, storeFile, getFile } from '../../data/idb';
import {
  updateAlbum,
  updateSong,
  updateDifficulty,
  deleteAlbum,
  deleteSong,
  deleteDifficulty,
  addSong,
  addDifficulty,
} from '../../data/libraryStore';
import { readChartMeta } from '../../data/zipImport';
import { loadChartForDifficulty } from '../../data/beatmapLoader';

interface Props {
  selection: Selection;
  library: AlbumItem[];
  onChanged: () => void;
  onSelect: (s: Selection) => void;
  onPlay: (chart: ChartData, audioFile?: File) => void;
  onMessage: (msg: string) => void;
}

function resolve(selection: Selection, library: AlbumItem[]) {
  if (!selection) return { album: null as AlbumItem | null, song: null as SongItem | null, diff: null as DifficultyEntry | null };
  const album = library.find((a) => a.id === selection.albumId);
  if (!album) return { album: null, song: null, diff: null };
  if (selection.kind === 'album') return { album, song: null, diff: null };
  const song = album.songs.find((s): s is SongItem => s.type === 'song' && s.id === selection.songId) ?? null;
  if (!song) return { album, song: null, diff: null };
  if (selection.kind === 'song') return { album, song, diff: null };
  const diff = song.difficulties[selection.index] ?? null;
  return { album, song, diff };
}

export function EditorPanel({ selection, library, onChanged, onSelect, onPlay, onMessage }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const diffInputRef = useRef<HTMLInputElement>(null);

  const { album, song, diff } = resolve(selection, library);

  useEffect(() => {
    if (!album) {
      setDraft({});
      return;
    }
    if (selection?.kind === 'album') {
      setDraft({
        title: album.title,
        artist: album.artist ?? '',
        accentColor: album.accentColor ?? '#22d3ee',
      });
    } else if (selection?.kind === 'song' && song) {
      setDraft({
        title: song.title,
        artist: song.artist,
        bpm: String(song.bpm),
        accentColor: song.accentColor ?? '#22d3ee',
      });
    } else if (selection?.kind === 'diff' && diff) {
      setDraft({
        name: diff.name,
        level: diff.level != null ? String(diff.level) : '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, library]);

  if (!selection || !album) {
    return (
      <div className="text-[#6b7f93] text-sm p-8 text-center">{t('filemgr.selectHint')}</div>
    );
  }

  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const persistText = async () => {
    if (selection.kind === 'album') {
      await updateAlbum(album.id, {
        title: draft.title.trim() || '未命名专辑',
        artist: draft.artist,
        accentColor: draft.accentColor,
      });
    } else if (selection.kind === 'song' && song) {
      await updateSong(album.id, song.id, {
        title: draft.title.trim() || '未命名歌曲',
        artist: draft.artist,
        bpm: Number(draft.bpm) || 120,
        accentColor: draft.accentColor,
      });
    } else if (selection.kind === 'diff' && diff) {
      await updateDifficulty(album.id, song!.id, selection.index, {
        name: draft.name.trim() || 'NORMAL',
        level: draft.level.trim() ? Number(draft.level) : undefined,
      });
    }
    onMessage(t('filemgr.saved'));
    onChanged();
  };

  const handleFile = async (field: 'cover' | 'audio' | 'chartFile', file: File) => {
    const ref = await storeFile(file);
    if (selection.kind === 'album') {
      await updateAlbum(album.id, { cover: ref });
    } else if (selection.kind === 'song' && song) {
      await updateSong(album.id, song.id, { [field]: ref });
    } else if (selection.kind === 'diff' && diff) {
      const meta = await readChartMeta(file);
      await updateDifficulty(album.id, song!.id, selection.index, {
        chartFile: ref,
        name: meta?.difficulty ?? draft.name,
        level: meta?.level ?? (draft.level.trim() ? Number(draft.level) : undefined),
        noteCount: meta?.noteCount,
      });
      onMessage(t('filemgr.chartUpdated'));
    }
    onChanged();
  };

  const handleDelete = async () => {
    if (selection.kind === 'album') {
      await deleteAlbum(album.id);
      onSelect(null);
    } else if (selection.kind === 'song' && song) {
      await deleteSong(album.id, song.id);
      onSelect({ kind: 'album', albumId: album.id });
    } else if (selection.kind === 'diff') {
      await deleteDifficulty(album.id, song!.id, selection.index);
      onSelect({ kind: 'song', albumId: album.id, songId: song!.id });
    }
    onMessage(t('filemgr.deleted'));
    onChanged();
  };

  const handleAddSong = async () => {
    const newSong: SongItem = {
      type: 'song',
      id: generateId('song'),
      title: '新歌曲',
      artist: '',
      bpm: 120,
      cover: '',
      accentColor: album.accentColor ?? '#22d3ee',
      audio: '',
      basePath: '',
      difficulties: [],
    };
    await addSong(album.id, newSong);
    onSelect({ kind: 'song', albumId: album.id, songId: newSong.id });
    onChanged();
  };

  const handleAddDifficulty = async (file: File) => {
    const ref = await storeFile(file);
    const meta = await readChartMeta(file);
    const newDiff: DifficultyEntry = {
      name: meta?.difficulty ?? 'NORMAL',
      level: meta?.level ?? 1,
      chartFile: ref,
      noteCount: meta?.noteCount,
    };
    await addDifficulty(album.id, song!.id, newDiff);
    onSelect({
      kind: 'diff',
      albumId: album.id,
      songId: song!.id,
      index: song!.difficulties.length,
    });
    onMessage(t('filemgr.diffAdded'));
    onChanged();
  };

  const handlePlay = async (idx: number) => {
    if (!song) return;
    try {
      const chart = await loadChartForDifficulty(song, idx);
      let audioFile: File | undefined;
      if (song.audio) {
        if (song.audio.startsWith('idb://')) {
          const blob = await getFile(song.audio.replace(/^idb:\/\//, ''));
          if (blob) audioFile = new File([blob], 'audio', { type: blob.type });
        } else {
          const res = await fetch(song.audio);
          const blob = await res.blob();
          audioFile = new File([blob], 'audio', { type: blob.type });
        }
      }
      onPlay(chart, audioFile);
    } catch (e) {
      console.error(e);
      onMessage(t('filemgr.playError'));
    }
  };

  const headerLabel =
    selection.kind === 'album' ? t('filemgr.album') : selection.kind === 'song' ? t('filemgr.song') : t('filemgr.difficulty');

  return (
    <div className="p-5 overflow-y-auto h-full">
      <div className="text-xs uppercase tracking-[0.2em] text-[#9fb4c7] font-orbitron mb-4">
        {headerLabel}
      </div>

      {/* Album editor */}
      {selection.kind === 'album' && (
        <>
          <Field label={t('filemgr.fieldTitle')} value={draft.title} onChange={(v) => set('title', v)} />
          <Field label={t('filemgr.artist')} value={draft.artist} onChange={(v) => set('artist', v)} />
          <div className="mb-3">
            <div className="text-xs text-[#9fb4c7] mb-1.5 font-orbitron tracking-wide">
              {t('filemgr.accent')}
            </div>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={draft.accentColor}
                onChange={(e) => set('accentColor', e.target.value)}
                className="w-10 h-10 rounded-lg border border-white/10 bg-transparent cursor-pointer"
              />
              <span className="text-xs text-[#6b7f93]">{draft.accentColor}</span>
            </div>
          </div>
          <FileField
            label={t('filemgr.cover')}
            accept="image/*"
            value={album.cover}
            onFile={(f) => handleFile('cover', f)}
          />
          <div className="flex flex-wrap gap-2 mt-4">
            <button className="glass-btn-primary px-4 py-2 text-sm" onClick={persistText}>
              {t('filemgr.save')}
            </button>
            <button className="glass-btn px-4 py-2 text-sm" onClick={handleAddSong}>
              + {t('filemgr.newSong')}
            </button>
            <button className="glass-btn px-4 py-2 text-sm text-red-300" onClick={handleDelete}>
              {t('filemgr.delete')}
            </button>
          </div>
        </>
      )}

      {/* Song editor */}
      {selection.kind === 'song' && song && (
        <>
          <Field label={t('filemgr.fieldTitle')} value={draft.title} onChange={(v) => set('title', v)} />
          <Field label={t('filemgr.artist')} value={draft.artist} onChange={(v) => set('artist', v)} />
          <Field
            label={t('filemgr.bpm')}
            value={draft.bpm}
            onChange={(v) => set('bpm', v)}
            type="number"
          />
          <div className="mb-3">
            <div className="text-xs text-[#9fb4c7] mb-1.5 font-orbitron tracking-wide">
              {t('filemgr.accent')}
            </div>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={draft.accentColor}
                onChange={(e) => set('accentColor', e.target.value)}
                className="w-10 h-10 rounded-lg border border-white/10 bg-transparent cursor-pointer"
              />
              <span className="text-xs text-[#6b7f93]">{draft.accentColor}</span>
            </div>
          </div>
          <FileField
            label={t('filemgr.cover')}
            accept="image/*"
            value={song.cover}
            onFile={(f) => handleFile('cover', f)}
          />
          <FileField
            label={t('filemgr.audio')}
            accept="audio/*"
            value={song.audio}
            onFile={(f) => handleFile('audio', f)}
          />

          <div className="mt-4 mb-2 text-xs uppercase tracking-[0.2em] text-[#9fb4c7] font-orbitron">
            {t('filemgr.difficulties')}
          </div>
          <div className="space-y-2 mb-3">
            {song.difficulties.map((d, i) => (
              <div key={i} className="flex items-center justify-between glass-sub rounded-lg px-3 py-2">
                <button
                  className="text-left"
                  onClick={() =>
                    onSelect({ kind: 'diff', albumId: album.id, songId: song.id, index: i })
                  }
                >
                  <div className="text-sm text-[#e5f6ff]">{d.name}</div>
                  <div className="text-[11px] text-[#6b7f93]">
                    {d.level != null && <>Lv.{d.level} · </>}{d.noteCount ?? 0} notes
                  </div>
                </button>
                <button
                  className="glass-btn text-xs px-2.5 py-1 text-cyan-300"
                  onClick={() => handlePlay(i)}
                >
                  ▶
                </button>
              </div>
            ))}
            {song.difficulties.length === 0 && (
              <div className="text-[11px] text-[#6b7f93]">{t('filemgr.noDiff')}</div>
            )}
          </div>
          <input
            ref={diffInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleAddDifficulty(f);
              e.target.value = '';
            }}
          />

          <div className="flex flex-wrap gap-2 mt-4">
            <button className="glass-btn-primary px-4 py-2 text-sm" onClick={persistText}>
              {t('filemgr.save')}
            </button>
            <button className="glass-btn px-4 py-2 text-sm" onClick={() => diffInputRef.current?.click()}>
              + {t('filemgr.newDifficulty')}
            </button>
            <button className="glass-btn px-4 py-2 text-sm text-red-300" onClick={handleDelete}>
              {t('filemgr.delete')}
            </button>
          </div>
        </>
      )}

      {/* Difficulty editor */}
      {selection.kind === 'diff' && diff && (
        <>
          <Field label={t('filemgr.fieldName')} value={draft.name} onChange={(v) => set('name', v)} />
          <Field
            label={t('filemgr.level')}
            value={draft.level}
            onChange={(v) => set('level', v)}
            type="number"
          />
          <FileField
            label={t('filemgr.chart')}
            accept=".json,application/json"
            value={diff.chartFile}
            onFile={(f) => handleFile('chartFile', f)}
          />
          <div className="flex flex-wrap gap-2 mt-4">
            <button className="glass-btn-primary px-4 py-2 text-sm" onClick={persistText}>
              {t('filemgr.save')}
            </button>
            <button
              className="glass-btn px-4 py-2 text-sm text-cyan-300"
              onClick={() => handlePlay(selection.index)}
            >
              ▶ {t('filemgr.play')}
            </button>
            <button className="glass-btn px-4 py-2 text-sm text-red-300" onClick={handleDelete}>
              {t('filemgr.delete')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
