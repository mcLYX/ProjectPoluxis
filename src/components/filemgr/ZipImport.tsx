import { useState, useRef } from 'react';
import { useI18n } from '../../i18n';
import { importZip, ZipImportResult } from '../../data/zipImport';
import { mutateLibrary } from '../../data/libraryStore';
import { isSongItem } from '../../types/beatmap';

interface Props {
  onMessage: (msg: string) => void;
}

export function ZipImport({ onMessage }: Props) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<ZipImportResult | null>(null);
  const [error, setError] = useState('');
  const [imported, setImported] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (f: File) => {
    setFile(f);
    setError('');
    setImported(false);
    setParsing(true);
    try {
      const res = await importZip(f);
      if (res.songCount === 0) {
        setError(t('filemgr.zipNoContent'));
        setResult(null);
      } else {
        setResult(res);
      }
    } catch (e) {
      console.error(e);
      setError(t('filemgr.zipError'));
      setResult(null);
    } finally {
      setParsing(false);
    }
  };

  const confirmImport = async () => {
    if (!result) return;
    await mutateLibrary((al) => [...al, result.album]);
    setImported(true);
    onMessage(t('filemgr.zipImported'));
  };

  return (
    <div className="h-full overflow-y-auto p-6 flex flex-col items-center">
      <div className="text-sm text-[#9fb4c7] mb-6 text-center max-w-md">
        {t('filemgr.zipHint')}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = '';
        }}
      />
      <button className="glass-btn-primary px-6 py-3 text-base mb-6" onClick={() => inputRef.current?.click()}>
        {file ? file.name : `+ ${t('filemgr.zipSelect')}`}
      </button>

      {parsing && <div className="text-[#9fb4c7] text-sm">{t('filemgr.zipParsing')}…</div>}
      {error && <div className="text-red-300 text-sm mb-4">{error}</div>}

      {result && !imported && (
        <div className="w-full max-w-md glass-sub rounded-xl p-4">
          <div className="text-base text-[#e5f6ff] mb-1 font-orbitron">{result.album.title}</div>
          <div className="text-[11px] text-[#6b7f93] mb-3">
            {result.songCount} {t('filemgr.songs')} · {result.difficultyCount} {t('filemgr.difficulties')}
          </div>
          <div className="space-y-1.5 mb-4">
            {result.album.songs.filter(isSongItem).map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-lg px-3 py-1.5 bg-white/5">
                <span className="text-[13px] text-[#e5f6ff] truncate">{s.title}</span>
                <span className="text-[10px] text-[#6b7f93]">{s.difficulties.length} diff</span>
              </div>
            ))}
          </div>
          <button className="glass-btn-primary w-full py-2 text-sm" onClick={confirmImport}>
            ✓ {t('filemgr.zipImport')}
          </button>
        </div>
      )}

      {imported && (
        <div className="text-emerald-300 text-sm">{t('filemgr.zipImported')}</div>
      )}
    </div>
  );
}
