import { useRef, useState, type ReactNode } from 'react';
import {
  Plus,
  Pencil,
  Download,
  Trash2,
  Copy,
  Save,
  X,
  FolderPlus,
  Music,
  FileUp,
  AudioLines,
  Image as ImageIcon,
  FileJson,
} from 'lucide-react';
import type { BeatmapItem } from '../types/beatmap';
import { useI18n } from '../i18n';

export interface ClipboardItem {
  id: string;
  kind: 'song' | 'album';
  fromAlbumId: string | null;
}

export interface FloatingActionBarProps {
  visible: boolean;
  mode: 'add' | 'edit' | 'download' | 'none';
  expandedItem: BeatmapItem | null;
  inEditMode: boolean;
  onPickFiles: (files: File[], kind: 'import' | 'chart' | 'audio' | 'cover') => void;
  onNewAlbum: (name: string) => void;
  onNewSong: (name: string) => void;
  onEdit: () => void;
  onEditChart: () => void;
  onNewChart: () => void;
  onMove: () => void;
  onDelete: () => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onDownload: () => void;
}

export default function FloatingActionBar(props: FloatingActionBarProps) {
  const {
    visible,
    mode,
    expandedItem,
    inEditMode,
    onPickFiles,
    onNewAlbum,
    onNewSong,
    onEdit,
    onEditChart,
    onNewChart,
    onMove,
    onDelete,
    onSave,
    onCancelEdit,
    onDownload,
  } = props;

  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pickKind, setPickKind] = useState<'import' | 'chart' | 'audio' | 'cover' | null>(null);
  const [promptKind, setPromptKind] = useState<'album' | 'song' | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  if (!visible) return null;

  const pick = (kind: 'import' | 'chart' | 'audio' | 'cover') => {
    setPickKind(kind);
    setOpen(false);
    // 等待菜单关闭后再触发文件选择，避免点击被吞掉。
    requestAnimationFrame(() => fileRef.current?.click());
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    const kind = pickKind;
    e.target.value = '';
    setPickKind(null);
    if (kind && files.length) onPickFiles(files, kind);
  };

  const openPrompt = (kind: 'album' | 'song') => {
    setPromptKind(kind);
    setPromptValue('');
    setOpen(false);
  };

  const submitPrompt = () => {
    const name = promptValue.trim() || (promptKind === 'album' ? t('fab.newAlbum') : t('fab.newSong'));
    if (promptKind === 'album') onNewAlbum(name);
    else onNewSong(name);
    setPromptKind(null);
    setPromptValue('');
  };

  // 编辑态：直接显示保存 / 取消，不显示菜单。
  if (inEditMode) {
    return (
      <>
        <input ref={fileRef} type="file" multiple className="hidden" onChange={onFileChange} />
        <div className="flex items-center gap-2">
          <button
            data-ui-click="1"
            onClick={onCancelEdit}
            className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold"
          >
            <X size={16} /> {t('fab.cancelEdit')}
          </button>
          <button
            data-ui-click="1"
            onClick={onSave}
            className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-cyan-200"
          >
            <Save size={16} /> {t('fab.save')}
          </button>
        </div>
      </>
    );
  }

  type Item = { key: string; label: string; icon: ReactNode; onClick: () => void; danger?: boolean };

  let items: Item[] = [];
  if (mode === 'add') {
    items = [
      { key: 'import', label: t('fab.import'), icon: <FileUp size={18} />, onClick: () => pick('import') },
      { key: 'newAlbum', label: t('fab.newAlbum'), icon: <FolderPlus size={18} />, onClick: () => openPrompt('album') },
      { key: 'newSong', label: t('fab.newSong'), icon: <Music size={18} />, onClick: () => openPrompt('song') },
    ];
  } else if (mode === 'edit') {
    if (expandedItem && expandedItem.type === 'song') {
      items = [
        { key: 'importChart', label: t('fab.importChart'), icon: <FileJson size={18} />, onClick: () => pick('chart') },
        { key: 'changeAudio', label: t('fab.changeAudio'), icon: <AudioLines size={18} />, onClick: () => pick('audio') },
        { key: 'changeCover', label: t('fab.changeCover'), icon: <ImageIcon size={18} />, onClick: () => pick('cover') },
        { key: 'editChart', label: t('fab.editChart'), icon: <FileJson size={18} />, onClick: onEditChart },
        { key: 'newChart', label: t('fab.newChart'), icon: <Plus size={18} />, onClick: onNewChart },
      ];
    } else {
      items = [
        { key: 'changeCover', label: t('fab.changeCover'), icon: <ImageIcon size={18} />, onClick: () => pick('cover') },
      ];
    }
    items.push(
      { key: 'edit', label: t('fab.editInfo'), icon: <Pencil size={18} />, onClick: onEdit },
      { key: 'move', label: t('fab.move'), icon: <Copy size={18} />, onClick: onMove },
      { key: 'delete', label: t('fab.delete'), icon: <Trash2 size={18} />, onClick: () => setConfirmDelete(true), danger: true },
    );
  }

  const triggerLabel =
    mode === 'add' ? t('fab.triggerAdd') : mode === 'edit' ? t('fab.triggerEdit') : t('fab.download');
  const triggerIcon =
    mode === 'add' ? <Plus size={16} /> : mode === 'edit' ? <Pencil size={16} /> : <Download size={16} />;

  const handleTrigger = () => {
    if (mode === 'download') {
      onDownload();
      return;
    }
    setOpen((o) => !o);
  };

  return (
    <>
      <input ref={fileRef} type="file" multiple className="hidden" onChange={onFileChange} />

      {promptKind && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50" data-ui-click="1" onClick={() => setPromptKind(null)}>
          <div className="glass-panel-strong rounded-2xl p-5 w-[300px] flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-bold text-white/90">
              {promptKind === 'album' ? t('fab.nameAlbum') : t('fab.nameSong')}
            </div>
            <input
              autoFocus
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitPrompt(); }}
              placeholder={promptKind === 'album' ? t('fab.newAlbum') : t('fab.newSong')}
              className="glass-input rounded-xl px-3 py-2 text-sm text-white/90 outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                data-ui-click="1"
                onClick={() => setPromptKind(null)}
                className="glass-btn px-3 py-1.5 rounded-xl text-xs font-bold"
              >
                {t('common.cancel')}
              </button>
              <button
                data-ui-click="1"
                onClick={submitPrompt}
                className="glass-btn px-3 py-1.5 rounded-xl text-xs font-bold text-cyan-200"
              >
                {t('fab.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50" data-ui-click="1" onClick={() => setConfirmDelete(false)}>
          <div className="glass-panel-strong rounded-2xl p-5 w-[300px] flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-bold text-white/90">{t('fab.confirmDeleteTitle')}</div>
            <div className="text-xs text-white/60">
              {expandedItem?.type === 'album' ? t('fab.confirmDeleteAlbum') : t('fab.confirmDeleteSong')}
            </div>
            <div className="flex justify-end gap-2">
              <button
                data-ui-click="1"
                onClick={() => setConfirmDelete(false)}
                className="glass-btn px-3 py-1.5 rounded-xl text-xs font-bold"
              >
                {t('common.cancel')}
              </button>
              <button
                data-ui-click="1"
                onClick={() => { setConfirmDelete(false); onDelete(); }}
                className="glass-btn px-3 py-1.5 rounded-xl text-xs font-bold text-red-300"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="relative flex items-center">
        <button
          data-ui-click="1"
          onClick={handleTrigger}
          className="glass-btn flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold"
        >
          {triggerIcon}
          <span>{triggerLabel}</span>
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-50" data-ui-click="1" onClick={() => setOpen(false)} />
            <div className="absolute bottom-full right-0 mb-2 z-[60] glass-panel-strong rounded-2xl p-2 min-w-[210px] flex flex-col gap-1 shadow-2xl border border-white/15 animate-fade-in">
              {items.map((it) => (
                <button
                  key={it.key}
                  data-ui-click="1"
                  onClick={it.onClick}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold transition ${
                    it.danger ? 'text-red-300 hover:bg-red-500/15' : 'text-white/85 hover:bg-white/10'
                  }`}
                >
                  <span className="opacity-80">{it.icon}</span>
                  <span>{it.label}</span>
                </button>
              ))}
              {items.length === 0 && (
                <div className="px-3 py-2 text-xs text-white/40">{t('fab.noActions')}</div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
