import { useState, useEffect, type ReactElement } from 'react';
import { ChevronRight } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { BeatmapItem, SongItem } from '../../types/beatmap';
import {
  getServers,
  getCurrentServer,
  addServer,
  updateServer,
  removeServer,
  setCurrentServer,
} from '../../data/onlineServers';
import { loadOnlineManifest, countLeafSongs } from '../../data/beatmapLoader';
import { addSongToDownloads } from '../../data/libraryStore';
import { storeFile } from '../../data/idb';

interface Props {
  onMessage: (msg: string) => void;
}

async function fetchAndStore(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败: ${res.status}`);
  const blob = await res.blob();
  const name = url.split('/').pop() || 'file';
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  return storeFile(file);
}

export function ServerManager({ onMessage }: Props) {
  const { t } = useI18n();
  const [servers, setServers] = useState(getServers());
  const [current, setCurrent] = useState(getCurrentServer());
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [formLabel, setFormLabel] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [onlineAlbums, setOnlineAlbums] = useState<BeatmapItem[]>([]);
  const [loadingOnline, setLoadingOnline] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState<string | null>(null);

  const toggleAlbum = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const refresh = () => {
    setServers(getServers());
    setCurrent(getCurrentServer());
  };

  const loadOnline = async () => {
    const srv = getCurrentServer();
    if (!srv) {
      setOnlineAlbums([]);
      return;
    }
    setLoadingOnline(true);
    try {
      const m = await loadOnlineManifest(srv.baseUrl);
      // normalizeManifest 已经把嵌套/混合/损坏的数据规整为递归树，这里直接信任
      setOnlineAlbums((m?.items ?? []) as BeatmapItem[]);
    } catch (e) {
      console.error(e);
      setOnlineAlbums([]);
    } finally {
      setLoadingOnline(false);
    }
  };

  useEffect(() => {
    loadOnline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startEdit = (id: string, label: string, url: string) => {
    setEditingId(id);
    setFormLabel(label);
    setFormUrl(url);
  };

  const startAdd = () => {
    setEditingId('new');
    setFormLabel('');
    setFormUrl('');
  };

  const saveEdit = () => {
    if (editingId === 'new') {
      addServer(formLabel, formUrl);
    } else if (editingId) {
      updateServer(editingId, { label: formLabel, baseUrl: formUrl });
    }
    setEditingId(null);
    refresh();
    loadOnline();
  };

  const handleDelete = (id: string) => {
    removeServer(id);
    refresh();
    loadOnline();
  };

  const handleSetCurrent = (id: string) => {
    setCurrentServer(id);
    refresh();
    loadOnline();
  };

  const downloadSong = async (song: SongItem) => {
    const key = song.id;
    setDownloading(key);
    try {
      const audioRef = song.audio ? await fetchAndStore(song.audio) : '';
      const coverRef = song.cover ? await fetchAndStore(song.cover) : '';
      const difficulties = [];
      for (const d of song.difficulties) {
        const chartRef = d.chartFile ? await fetchAndStore(d.chartFile) : '';
        difficulties.push({ ...d, chartFile: chartRef });
      }
      const localSong: SongItem = {
        ...song,
        audio: audioRef,
        cover: coverRef,
        difficulties,
        source: 'local',
      };
      await addSongToDownloads(localSong);
      onMessage(t('filemgr.downloadDone'));
    } catch (e) {
      console.error(e);
      onMessage(t('filemgr.downloadError'));
    } finally {
      setDownloading(null);
    }
  };

  // 递归渲染服务器上的谱面树：album=文件夹（可嵌套/为空/混排），song=可下载文件
  const renderNode = (node: BeatmapItem, depth: number): ReactElement => {
    if (node.type === 'song') {
      return (
        <div
          key={node.id}
          className="flex items-center justify-between rounded-lg px-3 py-2 bg-white/5"
          style={{ marginLeft: depth > 0 ? depth * 10 : 0 }}
        >
          <div className="min-w-0">
            <div className="text-[13px] text-[#e5f6ff] truncate">{node.title}</div>
            <div className="text-[10px] text-[#6b7f93]">
              {(node.difficulties || []).length} {t('filemgr.difficulties')}
            </div>
          </div>
          <button
            className="glass-btn text-xs px-3 py-1.5 text-amber-300 disabled:opacity-40"
            disabled={downloading === node.id}
            onClick={() => downloadSong(node)}
          >
            {downloading === node.id ? '…' : `↓ ${t('filemgr.download')}`}
          </button>
        </div>
      );
    }
    // album（文件夹，可展开/收起，默认收起）
    const isOpen = expanded.has(node.id);
    return (
      <div
        key={node.id}
        className="glass-sub rounded-xl p-3"
        style={{ marginLeft: depth > 0 ? depth * 8 : 0 }}
      >
        <button
          type="button"
          onClick={() => toggleAlbum(node.id)}
          className="w-full text-left text-sm text-[#e5f6ff] font-orbitron flex items-center gap-2"
        >
          <ChevronRight
            size={14}
            className={`shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
          />
          <span className="truncate">{node.title}</span>
          <span className="text-[10px] text-[#6b7f93] font-normal shrink-0">
            ({countLeafSongs(node)} {t('filemgr.tracks')})
          </span>
        </button>
        {isOpen && (
          <div className="space-y-1.5 mt-2">
            {node.songs.length === 0 ? (
              <div className="text-[11px] text-[#6b7f93] px-1">{t('filemgr.emptyAlbum')}</div>
            ) : (
              node.songs.map((child) => renderNode(child, depth + 1))
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full">
      {/* Server list */}
      <div className="w-80 flex-shrink-0 overflow-y-auto border-r border-white/10 p-3 space-y-2">
        <div className="text-xs uppercase tracking-[0.2em] text-[#9fb4c7] font-orbitron mb-2">
          {t('filemgr.servers')}
        </div>
        {servers.map((s) => (
          <div
            key={s.id}
            className={`glass-sub rounded-xl p-3 ${current?.id === s.id ? 'ring-1 ring-cyan-400/60' : ''}`}
          >
            {editingId === s.id ? (
              <div className="space-y-2">
                <input
                  className="w-full glass-input text-sm px-2 py-1.5 rounded"
                  value={formLabel}
                  onChange={(e) => setFormLabel(e.target.value)}
                  placeholder={t('filemgr.serverLabel')}
                />
                <input
                  className="w-full glass-input text-xs px-2 py-1.5 rounded"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  placeholder="https://..."
                />
                <div className="flex gap-2">
                  <button className="glass-btn-primary text-xs px-3 py-1" onClick={saveEdit}>
                    {t('filemgr.save')}
                  </button>
                  <button className="glass-btn text-xs px-3 py-1" onClick={() => setEditingId(null)}>
                    {t('filemgr.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div className="text-sm text-[#e5f6ff] truncate">{s.label}</div>
                  {current?.id === s.id && (
                    <span className="text-[10px] text-cyan-300 font-orbitron">{t('filemgr.current')}</span>
                  )}
                </div>
                <div className="text-[10px] text-[#6b7f93] truncate mb-2">{s.baseUrl}</div>
                <div className="flex flex-wrap gap-1.5 items-center">
                  <button
                    className="glass-btn text-[11px] px-2 py-1 text-cyan-300"
                    onClick={() => handleSetCurrent(s.id)}
                  >
                    {t('filemgr.setCurrent')}
                  </button>
                  {!s.fixed && (
                    <button
                      className="glass-btn text-[11px] px-2 py-1"
                      onClick={() => startEdit(s.id, s.label, s.baseUrl)}
                    >
                      {t('filemgr.edit')}
                    </button>
                  )}
                  {!s.fixed && (
                    <button
                      className="glass-btn text-[11px] px-2 py-1 text-red-300"
                      onClick={() => handleDelete(s.id)}
                    >
                      {t('filemgr.delete')}
                    </button>
                  )}
                  {s.fixed && (
                    <span className="text-[10px] text-amber-300 font-orbitron px-1">
                      {t('filemgr.current')} · {t('filemgr.fixed')}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
        {editingId === 'new' ? (
          <div className="glass-sub rounded-xl p-3 space-y-2">
            <input
              className="w-full glass-input text-sm px-2 py-1.5 rounded"
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              placeholder={t('filemgr.serverLabel')}
            />
            <input
              className="w-full glass-input text-xs px-2 py-1.5 rounded"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              placeholder="https://..."
            />
            <div className="flex gap-2">
              <button className="glass-btn-primary text-xs px-3 py-1" onClick={saveEdit}>
                {t('filemgr.addServer')}
              </button>
              <button className="glass-btn text-xs px-3 py-1" onClick={() => setEditingId(null)}>
                {t('filemgr.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button className="glass-btn w-full text-sm py-2" onClick={startAdd}>
            + {t('filemgr.addServer')}
          </button>
        )}
      </div>

      {/* Current server content */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4">
        <div className="text-xs uppercase tracking-[0.2em] text-[#9fb4c7] font-orbitron mb-3">
          {current ? `${current.label} · ${t('filemgr.online')}` : t('filemgr.noServer')}
        </div>
        {loadingOnline && <div className="text-[#6b7f93] text-sm">{t('filemgr.loading')}…</div>}
        {!loadingOnline && onlineAlbums.length === 0 && (
          <div className="text-[#6b7f93] text-sm">{t('filemgr.serverEmpty')}</div>
        )}
        <div className="space-y-3">
          {onlineAlbums.map((node) => renderNode(node, 0))}
        </div>
      </div>
    </div>
  );
}
