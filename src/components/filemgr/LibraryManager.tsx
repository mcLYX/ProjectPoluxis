import { useState, useEffect, useRef } from 'react';
import { useI18n } from '../../i18n';
import type { AlbumItem } from '../../types/beatmap';
import { isSongItem } from '../../types/beatmap';
import type { ChartData } from '../../types/game';
import { getLibrary } from '../../data/idb';
import { createAlbum } from '../../data/libraryStore';
import { parseAndValidateChart } from '../../utils/chartParser';
import { Selection, CoverThumb } from './shared';
import { EditorPanel } from './EditorPanel';

interface Props {
  onMessage: (msg: string) => void;
  onSelectCustomSong: (chart: ChartData, audioFile?: File) => void;
}

export function LibraryManager({ onMessage, onSelectCustomSong }: Props) {
  const { t } = useI18n();
  const [library, setLibrary] = useState<AlbumItem[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [expandedAlbums, setExpandedAlbums] = useState<Record<string, boolean>>({});
  const [expandedSongs, setExpandedSongs] = useState<Record<string, boolean>>({});
  const [showQuick, setShowQuick] = useState(false);
  const [quickChart, setQuickChart] = useState<File | null>(null);
  const [quickAudio, setQuickAudio] = useState<File | null>(null);
  const chartInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const reload = async () => {
    const albums = await getLibrary();
    setLibrary(albums);
  };

  useEffect(() => {
    reload();
  }, []);

  const toggleAlbum = (id: string) =>
    setExpandedAlbums((e) => ({ ...e, [id]: !e[id] }));
  const toggleSong = (id: string) =>
    setExpandedSongs((e) => ({ ...e, [id]: !e[id] }));

  const handleNewAlbum = async () => {
    const album = await createAlbum({ title: t('filemgr.newAlbumDefault') });
    setSelection({ kind: 'album', albumId: album.id });
    setExpandedAlbums((e) => ({ ...e, [album.id]: true }));
  };

  const handleQuickPlay = async () => {
    if (!quickChart) {
      onMessage(t('filemgr.quickNeedChart'));
      return;
    }
    try {
      const text = await quickChart.text();
      const result = parseAndValidateChart(JSON.parse(text));
      if (!result.valid || !result.chart) {
        onMessage(t('filemgr.chartError'));
        return;
      }
      onSelectCustomSong(result.chart, quickAudio ?? undefined);
    } catch (e) {
      console.error(e);
      onMessage(t('filemgr.chartError'));
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2 border-b border-white/10">
        <button className="glass-btn-primary px-3 py-1.5 text-sm" onClick={handleNewAlbum}>
          + {t('filemgr.newAlbum')}
        </button>
        <button className="glass-btn px-3 py-1.5 text-sm" onClick={() => setShowQuick((v) => !v)}>
          {t('filemgr.quickPlay')}
        </button>
        <span className="text-[11px] text-[#6b7f93] ml-auto">
          {library.length} {t('filemgr.albums')}
        </span>
      </div>

      {showQuick && (
        <div className="px-4 py-3 glass-sub m-3 rounded-xl flex flex-wrap items-center gap-3">
          <input
            ref={chartInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => setQuickChart(e.target.files?.[0] ?? null)}
          />
          <input
            ref={audioInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => setQuickAudio(e.target.files?.[0] ?? null)}
          />
          <button className="glass-btn text-xs px-3 py-1.5" onClick={() => chartInputRef.current?.click()}>
            {quickChart ? quickChart.name : t('filemgr.chooseChart')}
          </button>
          <button className="glass-btn text-xs px-3 py-1.5" onClick={() => audioInputRef.current?.click()}>
            {quickAudio ? quickAudio.name : t('filemgr.chooseAudio')}
          </button>
          <button className="glass-btn-primary text-xs px-4 py-1.5" onClick={handleQuickPlay}>
            ▶ {t('filemgr.play')}
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Tree */}
        <div className="w-72 flex-shrink-0 overflow-y-auto border-r border-white/10 p-2 space-y-1">
          {library.length === 0 && (
            <div className="text-[#6b7f93] text-sm p-4 text-center">{t('filemgr.emptyLibrary')}</div>
          )}
          {library.map((album) => (
            <div key={album.id}>
              <div
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition ${
                  selection?.kind === 'album' && selection.albumId === album.id
                    ? 'bg-white/10'
                    : 'hover:bg-white/5'
                }`}
                onClick={() => {
                  toggleAlbum(album.id);
                  setSelection({ kind: 'album', albumId: album.id });
                }}
              >
                <CoverThumb
                  src={album.cover}
                  className="w-8 h-8 rounded-md border border-white/10 flex-shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-[#e5f6ff] truncate">{album.title}</div>
                  <div className="text-[10px] text-[#6b7f93]">
                    {album.songs.length} {t('filemgr.songs')}
                  </div>
                </div>
                <span className="text-[#6b7f93] text-xs">{expandedAlbums[album.id] ? '▾' : '▸'}</span>
              </div>

              {expandedAlbums[album.id] &&
              album.songs.filter(isSongItem).map((song) => (
                  <div key={song.id} className="ml-6">
                    <div
                      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition ${
                        selection?.kind === 'song' && selection.songId === song.id
                          ? 'bg-white/10'
                          : 'hover:bg-white/5'
                      }`}
                      onClick={() => {
                        toggleSong(song.id);
                        setSelection({ kind: 'song', albumId: album.id, songId: song.id });
                      }}
                    >
                      <CoverThumb
                        src={song.cover}
                        className="w-7 h-7 rounded-md border border-white/10 flex-shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] text-[#e5f6ff] truncate">{song.title}</div>
                        <div className="text-[10px] text-[#6b7f93]">
                          {song.difficulties.length} {t('filemgr.difficulties')}
                        </div>
                      </div>
                      <span className="text-[#6b7f93] text-xs">{expandedSongs[song.id] ? '▾' : '▸'}</span>
                    </div>

                    {expandedSongs[song.id] &&
                      song.difficulties.map((d, i) => (
                        <div
                          key={i}
                          className={`ml-6 flex items-center justify-between rounded-lg px-2 py-1 cursor-pointer transition ${
                            selection?.kind === 'diff' &&
                            selection.songId === song.id &&
                            selection.index === i
                              ? 'bg-white/10'
                              : 'hover:bg-white/5'
                          }`}
                          onClick={() =>
                            setSelection({
                              kind: 'diff',
                              albumId: album.id,
                              songId: song.id,
                              index: i,
                            })
                          }
                        >
                          <span className="text-[12px] text-[#cfe6f5] truncate">
                            {d.name} <span className="text-[#6b7f93]">Lv.{d.level}</span>
                          </span>
                        </div>
                      ))}
                  </div>
                ))}
            </div>
          ))}
        </div>

        {/* Editor */}
        <div className="flex-1 min-w-0">
          <EditorPanel
            selection={selection}
            library={library}
            onChanged={reload}
            onSelect={setSelection}
            onPlay={(chart, audioFile) => onSelectCustomSong(chart, audioFile)}
            onMessage={onMessage}
          />
        </div>
      </div>
    </div>
  );
}
