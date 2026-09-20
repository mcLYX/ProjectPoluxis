/**
 * 右上角「账号」入口：圆形头像 + 昵称胶囊；点击展开下拉列表，
 * 承载原先散落在主界面的「设置 / 编辑器 / Lite 版」三个入口。
 *
 * 视觉沿用游戏既有的暗色玻璃拟态 + 青色强调语言（glass-btn / glass-panel-strong）。
 *
 * 注意：项目启用 <StrictMode>（见 main.tsx），effect 会执行两次，因此
 * 「点击外部关闭 / Esc 关闭」的监听必须在 cleanup 中成对解绑，
 * 否则会叠加两份监听导致一次点击被处理两次。
 */
import { useEffect, useRef, useState } from 'react';
import { FileCode, Sliders, Smartphone, User } from 'lucide-react';
import { useI18n } from '../i18n';
import { getDisplayAccount, useAccount } from '../accountStore';
import { useAvatarUrl } from '../hooks/useAvatarUrl';

export interface AccountMenuProps {
  onOpenSettings: () => void;
  onOpenEditor: () => void;
  onSwitchLite: () => void;
  /**
   * 面板相对按钮的展开位置：
   *  - `'bottom-left'`：向上展开且左对齐（控件位于左下角时使用，避免向左溢出屏幕）。
   *  - `'top-right'`：向下展开且右对齐（控件位于右上角时使用）。
   */
  placement?: 'top-right' | 'bottom-left';
}

export const AccountMenu: React.FC<AccountMenuProps> = ({
  onOpenSettings,
  onOpenEditor,
  onSwitchLite,
  placement = 'top-right',
}) => {
  const openUp = placement === 'bottom-left';
  const { t } = useI18n();
  const account = useAccount();
  const display = getDisplayAccount(account);
  const avatarUrl = useAvatarUrl(display.avatar);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /* 点击外部 / Esc 关闭面板。监听与解绑严格成对（StrictMode 双挂载安全）。 */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const root = rootRef.current;
      if (root && !root.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const items: { key: string; label: string; icon: typeof Sliders; action: () => void }[] = [
    { key: 'settings', label: t('songselect.settings'), icon: Sliders, action: onOpenSettings },
    { key: 'editor', label: t('songselect.edit'), icon: FileCode, action: onOpenEditor },
    { key: 'lite', label: t('songselect.lite'), icon: Smartphone, action: onSwitchLite },
  ];

  return (
    <div ref={rootRef} className="relative pointer-events-auto">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={display.nickname}
        className="glass-btn flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full font-bold
                   transition-transform duration-150 hover:scale-[1.03] active:scale-[0.98]
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
      >
        <span
          className="relative h-9 w-9 shrink-0 rounded-full overflow-hidden grid place-items-center
                     ring-1 ring-white/40 bg-gradient-to-br from-cyan-400/35 via-sky-500/25 to-amber-300/25"
          style={{ boxShadow: '0 0 10px rgba(34,211,238,0.35), inset 0 1px 0 rgba(255,255,255,0.2)' }}
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-full w-full object-cover" draggable={false} />
          ) : (
            <User size={17} className="text-white/85" />
          )}
        </span>
        <span className="max-w-[6.5rem] truncate text-xs text-white/90">{display.nickname}</span>
      </button>

      {/* 下拉面板：按 placement 对齐，列表形式纵向排列三个入口。
          注意：Tailwind 任意值里的空格必须写成 `_`，否则 calc() 为非法 CSS、定位会失效。 */}
      <div
        role="menu"
        aria-hidden={!open}
        className={`absolute z-30 w-44 max-w-[calc(100vw_-_3rem)] rounded-2xl
                    glass-panel-strong p-1.5 transition-all duration-150 ease-out
                    ${openUp
                      ? 'bottom-[calc(100%_+_0.5rem)] left-0 origin-bottom-left'
                      : 'top-[calc(100%_+_0.5rem)] right-0 origin-top-right'}
                    ${open ? 'opacity-100 translate-y-0' : `opacity-0 pointer-events-none ${openUp ? 'translate-y-1' : '-translate-y-1'}`}`}
        style={{ boxShadow: '0 18px 40px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.14)' }}
      >
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              tabIndex={open ? 0 : -1}
              onClick={() => {
                setOpen(false);
                it.action();
              }}
              className="w-full flex items-center gap-2.5 h-10 px-2.5 rounded-xl text-sm font-bold
                         text-white/85 hover:text-white hover:bg-white/[0.11]
                         transition-all duration-150 hover:translate-x-0.5
                         focus:outline-none focus-visible:bg-white/[0.11]"
            >
              <Icon size={15} className="text-cyan-300" />
              <span>{it.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
