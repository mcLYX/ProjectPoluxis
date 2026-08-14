import { useState, useEffect, useRef } from 'react';
import { useI18n } from '../i18n';
import type { ChartData } from '../types/game';
import { LibraryManager } from './filemgr/LibraryManager';
import { ZipImport } from './filemgr/ZipImport';
import { ServerManager } from './filemgr/ServerManager';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectCustomSong: (chart: ChartData, audioFile?: File) => void;
}

type Tab = 'library' | 'zip' | 'servers';

export function FileManagerModal({ isOpen, onClose, onSelectCustomSong }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('library');
  const [message, setMessage] = useState('');
  const msgTimer = useRef<number | null>(null);

  const showMessage = (msg: string) => {
    setMessage(msg);
    if (msgTimer.current) window.clearTimeout(msgTimer.current);
    msgTimer.current = window.setTimeout(() => setMessage(''), 2600);
  };

  useEffect(() => {
    return () => {
      if (msgTimer.current) window.clearTimeout(msgTimer.current);
    };
  }, []);

  if (!isOpen) return null;

  const handlePlay = (chart: ChartData, audioFile?: File) => {
    onClose();
    onSelectCustomSong(chart, audioFile);
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'library', label: t('filemgr.tabLibrary') },
    { id: 'zip', label: t('filemgr.tabZip') },
    { id: 'servers', label: t('filemgr.tabServers') },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3">
      <div className="glass-panel-strong w-[min(1100px,96vw)] h-[min(840px,94vh)] flex flex-col rounded-2xl overflow-hidden animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
          <div className="font-orbitron text-lg tracking-[0.15em] text-[#e5f6ff]">
            {t('filemgr.heading')}
          </div>
          <button
            className="glass-btn w-9 h-9 rounded-full flex items-center justify-center text-lg"
            onClick={onClose}
            aria-label={t('filemgr.close')}
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 px-5 py-2 border-b border-white/10">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              className={`px-4 py-1.5 rounded-lg text-sm font-orbitron tracking-wide transition ${
                tab === tb.id ? 'glass-btn-primary' : 'glass-btn'
              }`}
              onClick={() => setTab(tb.id)}
            >
              {tb.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0">
          {tab === 'library' && (
            <LibraryManager onMessage={showMessage} onSelectCustomSong={handlePlay} />
          )}
          {tab === 'zip' && <ZipImport onMessage={showMessage} />}
          {tab === 'servers' && <ServerManager onMessage={showMessage} />}
        </div>

        {/* Toast */}
        {message && (
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full glass-panel text-sm text-[#e5f6ff] shadow-[0_0_20px_rgba(34,211,238,0.3)]">
            {message}
          </div>
        )}
      </div>
    </div>
  );
}
