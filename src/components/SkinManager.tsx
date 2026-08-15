import { useEffect, useRef, useState } from 'react';
import { Upload, Trash2, Palette, ImageOff } from 'lucide-react';
import { useI18n } from '../i18n';
import { resolveIdbUrl } from '../data/idb';
import { deleteSkin, importSkinZip, listSkins } from '../data/skinStore';
import type { SkinMeta } from '../types/game';

interface SkinManagerProps {
  selectedSkinId: string | null;
  onSelect: (id: string | null) => void;
}

/** Resolve an `idb://` preview ref into an object URL for <img>. */
async function resolvePreview(ref: string): Promise<string | null> {
  try {
    return await resolveIdbUrl(ref);
  } catch {
    return null;
  }
}

export default function SkinManager({ selectedSkinId, onSelect }: SkinManagerProps) {
  const { t } = useI18n();
  const [skins, setSkins] = useState<SkinMeta[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    listSkins().then(async (list) => {
      setSkins(list);
      const urls: Record<string, string> = {};
      await Promise.all(
        list.map(async (s) => {
          if (s.preview) {
            const url = await resolvePreview(s.preview);
            if (url) urls[s.id] = url;
          }
        }),
      );
      setPreviews(urls);
    });
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setImporting(true);
    try {
      const meta = await importSkinZip(file, t);
      refresh();
      onSelect(meta.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (skin: SkinMeta) => {
    if (!window.confirm(t('skin.deleteConfirm').replace('{name}', skin.name))) return;
    if (selectedSkinId === skin.id) onSelect(null);
    await deleteSkin(skin.id);
    refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 导入区 */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={importing}
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-cyan-400 px-4 py-2 text-sm font-semibold text-slate-900 shadow-lg shadow-cyan-500/30 transition hover:from-cyan-400 hover:to-cyan-300 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Upload size={16} />
          {importing ? t('skin.importing') : t('skin.import')}
        </button>
        <span className="text-xs leading-relaxed text-slate-400">{t('skin.hint')}</span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* 皮肤卡片网格 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {/* 默认（纯色）卡片 */}
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`group relative flex flex-col items-center gap-2 overflow-hidden rounded-xl border p-3 text-center transition-all duration-200 hover:-translate-y-0.5 ${
            selectedSkinId === null
              ? 'border-cyan-400 bg-cyan-400/10 shadow-lg shadow-cyan-500/30'
              : 'border-white/10 bg-white/5 hover:border-white/20'
          }`}
        >
          <div
            className={`flex h-16 w-16 items-center justify-center rounded-lg ${
              selectedSkinId === null ? 'bg-gradient-to-br from-cyan-400/30 to-fuchsia-400/30' : 'bg-white/10'
            }`}
          >
            <Palette size={26} className={selectedSkinId === null ? 'text-cyan-300' : 'text-slate-400'} />
          </div>
          <div className="text-sm font-semibold text-slate-100">{t('skin.default')}</div>
          <div className="text-xs text-slate-400">{t('skin.defaultDesc')}</div>
        </button>

        {skins.map((skin) => {
          const isSelected = selectedSkinId === skin.id;
          const preview = previews[skin.id];
          return (
            <div
              key={skin.id}
              className={`group relative flex flex-col items-center gap-2 overflow-hidden rounded-xl border p-3 text-center transition-all duration-200 hover:-translate-y-0.5 ${
                isSelected
                  ? 'border-cyan-400 bg-cyan-400/10 shadow-lg shadow-cyan-500/30'
                  : 'border-white/10 bg-white/5 hover:border-white/20'
              }`}
            >
              <button type="button" onClick={() => onSelect(skin.id)} className="flex flex-col items-center gap-2">
                <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg bg-white/10">
                  {preview ? (
                    <img src={preview} alt={skin.name} className="h-full w-full object-contain" />
                  ) : (
                    <ImageOff size={24} className="text-slate-500" />
                  )}
                </div>
                <div className="w-full truncate text-sm font-semibold text-slate-100" title={skin.name}>
                  {skin.name}
                </div>
                {skin.author && (
                  <div className="w-full truncate text-xs text-slate-400" title={skin.author}>
                    {t('skin.author')}: {skin.author}
                  </div>
                )}
              </button>
              <button
                type="button"
                onClick={() => handleDelete(skin)}
                title={t('skin.delete')}
                className="absolute right-2 top-2 rounded-md bg-black/40 p-1.5 text-slate-300 opacity-0 transition hover:bg-red-500/80 hover:text-white group-hover:opacity-100"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {!importing && skins.length === 0 && !error && (
        <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-center text-sm text-slate-400">
          {t('skin.empty')}
        </div>
      )}
    </div>
  );
}
