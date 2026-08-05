import React from 'react';
import { BookOpen, X, Sparkles, Layers } from 'lucide-react';
import { useI18n } from '../i18n';

interface DocModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DocModal: React.FC<DocModalProps> = ({ isOpen, onClose }) => {
  const { t } = useI18n();
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
      <div className="glass-panel-strong border-white/15 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col text-white font-rajdhani">
        <div className="flex items-center justify-between p-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/15 flex items-center justify-center text-cyan-300 border border-cyan-400/40">
              <BookOpen size={18} />
            </div>
            <div>
              <h2 className="text-xl font-bold font-orbitron tracking-wider text-white/90">
                {t('doc.title')}
              </h2>
              <p className="text-xs text-white/50">{t('doc.subtitle')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/10 text-white/55 hover:text-white">
            <X size={22} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6 text-sm">
          {/* Section 1: Note Types */}
          <div className="p-4 rounded-xl glass-sub border border-white/10">
            <h3 className="font-bold font-orbitron text-cyan-300 mb-3 flex items-center gap-2">
              <Layers size={16} /> 1. {t('doc.section1')}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="p-3 bg-white/[0.04] rounded-lg border border-white/10">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-cyan-400 text-sm">■ {t('doc.note.tap')}</span>
                </div>
                <p className="text-white/70">
                  {t('doc.note.tapDesc')}
                </p>
              </div>

              <div className="p-3 bg-white/[0.04] rounded-lg border border-white/10">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-sky-400 text-sm">● {t('doc.note.touch')}</span>
                </div>
                <p className="text-white/70">
                  {t('doc.note.touchDesc')}
                </p>
              </div>

              <div className="p-3 bg-white/[0.04] rounded-lg border border-emerald-500/30 md:col-span-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-emerald-400 text-sm">◆ {t('doc.note.slide')}</span>
                </div>
                <p className="text-white/70">
                  {t('doc.note.slideDesc')}
                </p>
              </div>
            </div>
          </div>

          {/* Section: Beat-based timing */}
          <div className="p-4 rounded-xl glass-sub border border-white/10">
            <h3 className="font-bold font-orbitron text-emerald-300 mb-3 flex items-center gap-2">
              <Sparkles size={16} /> 2. {t('doc.section2')}
            </h3>
            <div className="text-xs text-white/70 space-y-1">
              <p>{t('doc.section2.p1')}</p>
              <p><code className="text-cyan-300 bg-white/[0.06] px-1 rounded">timeSec = offset + (beat × 60 / BPM)</code></p>
              <p>{t('doc.section2.p3')}</p>
            </div>
          </div>

          {/* Section 3: Judgement & Scoring */}
          <div className="p-4 rounded-xl glass-sub border border-white/10">
            <h3 className="font-bold font-orbitron text-amber-300 mb-3 flex items-center gap-2">
              <Sparkles size={16} /> 3. {t('doc.section3')}
            </h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between p-2 rounded bg-orange-500/10 border border-orange-500/30">
                <span className="text-orange-400 font-bold">{t('doc.judge.sperfect')}</span>
                <span className="font-mono text-white">{t('doc.judge.sperfectRule')}</span>
              </div>
              <div className="flex justify-between p-2 rounded bg-yellow-500/10 border border-yellow-500/30">
                <span className="text-yellow-300 font-bold">{t('doc.judge.perfect')}</span>
                <span className="font-mono text-white">{t('doc.judge.perfectRule')}</span>
              </div>
              <div className="flex justify-between p-2 rounded bg-sky-500/10 border border-sky-500/30">
                <span className="text-sky-400 font-bold">{t('doc.judge.good')}</span>
                <span className="font-mono text-white">{t('doc.judge.goodRule')}</span>
              </div>
              <div className="flex justify-between p-2 rounded bg-red-500/10 border border-red-500/30">
                <span className="text-red-400 font-bold">{t('doc.judge.miss')}</span>
                <span className="font-mono text-white">{t('doc.judge.missRule')}</span>
              </div>
            </div>
          </div>
          <p>v0.0.2</p>
        </div>
        
        <div className="p-4 border-t border-white/10 flex justify-end bg-white/[0.03]">
          
          <button
            onClick={onClose}
            className="px-6 py-2 rounded-xl glass-btn-primary font-bold transition cursor-pointer active:scale-95"
          >
            {t('doc.gotIt')}
          </button>
        </div>
      </div>
    </div>
  );
};