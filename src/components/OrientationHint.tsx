/**
 * 横竖屏硬提示（全屏遮罩）。
 *
 * 竖屏（orientation: portrait）打开游戏时，整屏弹出硬性提示，建议横屏游玩；
 * 遮罩覆盖全部 UI、阻断交互，玩家必须旋转设备到横屏（提示自动消失）或主动点击
 * 「继续竖屏」关闭（关闭后本次会话内即便再转回竖屏也不再打扰，仍可正常游玩）。
 *
 * 注：Toy SDK 的 `setContainerMode({orientation:'landscape'})` 仅是向宿主容器发起的
 * 「请求」，是否被采纳由宿主 App 决定——实测安卓端 B 站 Toy 不会强制横屏，因此这里
 * 依赖真实朝向（matchMedia）来显隐，而非指望 SDK 主动旋转。
 */
import { useEffect, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { useI18n } from '../i18n';

function isPortrait(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(orientation: portrait)').matches;
}

export function OrientationHint() {
  const { t } = useI18n();
  const [portrait, setPortrait] = useState<boolean>(isPortrait);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(orientation: portrait)');
    const onChange = (e: MediaQueryListEvent | MediaQueryList) =>
      setPortrait('matches' in e ? e.matches : (e as MediaQueryList).matches);
    setPortrait(mq.matches);

    // 兼容新旧浏览器 API
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else (mq as MediaQueryList).addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else (mq as MediaQueryList).removeListener(onChange);
    };
  }, []);

  if (!portrait || dismissed) return null;

  return (
    <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-7 bg-black/90 backdrop-blur-sm px-8 text-center">
      <RotateCw size={88} className="text-cyan-300 animate-spin" />
      <div className="space-y-3">
        <div className="text-2xl short:text-xl font-black font-orbitron tracking-wide text-white drop-shadow-lg">
          {t('orientation.hint')}
        </div>
        <div className="text-sm short:text-xs text-white/70 leading-relaxed max-w-xs mx-auto">
          {t('orientation.subtitle')}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="mt-1 px-7 py-3 rounded-xl text-sm short:text-xs font-bold text-cyan-100 bg-cyan-400/15 border border-cyan-300/40 hover:bg-cyan-400/25 active:scale-95 transition"
      >
        {t('orientation.dismiss')}
      </button>
    </div>
  );
}
