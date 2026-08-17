import React from 'react';
import { Sparkles, Layers } from 'lucide-react';
import { useI18n } from '../i18n';

export const GITHUB_URL = 'https://github.com/mcLYX/ProjectPoluxis';

/** 内联 GitHub 图标（lucide-react 未内置）。 */
const GithubIcon: React.FC<{ size?: number; className?: string }> = ({ size = 16, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    aria-hidden="true"
  >
    <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
  </svg>
);

/** 说明 / 关于 的正文内容，用于设置-关于页。 */
export const DocContent: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="p-6 overflow-y-auto space-y-6 text-sm">
      <div>
      <span className="text-2xl sm:text-3xl font-black font-orbitron tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-sky-200 to-amber-300">
          Poluxis
      </span>
      <span className="text-[10px] font-bold font-orbitron uppercase tracking-[0.35em] text-white/40 mr-2 mt-1 self-start">
          Project
      </span>
      </div>

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

      {/* 底部：版本号 + GitHub 链接 */}
      <div className="flex items-center justify-between pt-2 border-t border-white/10">
        <span className="text-[11px] text-white/40 font-mono">v0.0.4.1</span>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-white/80 hover:bg-white/10 hover:text-white transition cursor-pointer active:scale-95 text-sm font-bold"
        >
          <GithubIcon size={16} />
          GitHub
        </a>
      </div>
    </div>
  );
};
