import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface GlassDropdownOption<T extends string> {
  value: T;
  label: string;
  /** 可选图标（菜单态：AccountMenu / FloatingActionBar 等）。 */
  icon?: ReactNode;
  /** 危险操作（红色）。 */
  danger?: boolean;
}

/**
 * 通用玻璃（frosted-glass）自绘下拉 —— 项目内所有下拉/弹出菜单的统一实现。
 *
 * 两种形态（同一组件，参数区分）：
 *  - **选择器**（默认）：trigger = 当前值 + ▾，选中项高亮，面板宽 = trigger 宽。
 *  - **菜单**：传 `trigger` + `triggerClassName` 自绘按钮；`value` 可省略
 *    （省略则不显示选中高亮，纯动作菜单）；`direction/align` 控制弹出方向；
 *    选项可带 `icon` / `danger`。
 *
 * 弹层经 portal 渲染到 <body>（fixed 定位），避免被面板 overflow/transform 裁剪；
 * 页面滚动/缩放自动关闭（忽略弹层自身内部滚动）。SongSelect 容器用
 * `data-ui-click` 标记 UI 控件，菜单变体可经 `dataUiClick` 打上同款标记。
 */
export function GlassDropdown<T extends string>({
  value,
  options,
  onChange,
  className,
  accent = 'cyan',
  trigger,
  triggerClassName,
  triggerTitle,
  direction = 'down',
  align = 'left',
  panelClassName,
  itemClassName,
  dataUiClick = false,
}: {
  /** 当前值。菜单态（纯动作）可省略 → 无选中高亮。 */
  value?: T;
  options: Array<GlassDropdownOption<T>>;
  onChange: (v: T) => void;
  /** 外层容器的附加 class（宽度/栅格布局等）。 */
  className?: string;
  /** 主题色：cyan（默认）/ amber。 */
  accent?: 'cyan' | 'amber';
  /** 自绘 trigger 内容（图标菜单态）。缺省 = 「当前值 + ▾」选择器形态。 */
  trigger?: ReactNode;
  /** 自绘 trigger 按钮样式（与 trigger 搭配；缺省用选择器默认样式）。 */
  triggerClassName?: string;
  triggerTitle?: string;
  /** 弹出方向：down（默认，选择器）/ up（底部工具条与角落菜单）。 */
  direction?: 'down' | 'up';
  /** 弹层与 trigger 的对齐边：left（默认）/ right。 */
  align?: 'left' | 'right';
  /** 弹层形状 class（圆角/内边距/宽度）。缺省 = 选择器形状；传入则整体替换。 */
  panelClassName?: string;
  /** 菜单项 class（字号/行高等）。缺省 = 选择器项；传入则整体替换。 */
  itemClassName?: string;
  /** 给 trigger / 遮罩 / 菜单项打 data-ui-click="1"（SongSelect 容器约定）。 */
  dataUiClick?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!open) return;
    setRect(btnRef.current?.getBoundingClientRect() ?? null);
    const close = (e?: Event) => {
      const t = (e?.target as Node |null) ?? null;
      if (t && popRef.current && popRef.current.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  const current = value !== undefined ? options.find((o) => o.value === value) : undefined;
  const textCls = accent === 'amber' ? 'text-amber-300' : 'text-cyan-300';
  const selCls = accent === 'amber' ? 'bg-amber-500/25 text-amber-200' : 'bg-cyan-500/25 text-cyan-200';
  const uiAttr = dataUiClick ? { 'data-ui-click': '1' } : undefined;

  // 弹层定位：down=trigger 下缘下方；up=trigger 上缘上方（bottom 反推）。
  // align=right 时按 trigger 右缘对齐（角落菜单避免溢出屏幕右侧）。
  const posStyle: React.CSSProperties = rect
    ? {
        ...(align === 'left'
          ? { left: rect.left }
          : { right: window.innerWidth - rect.right }),
        ...(direction === 'down'
          ? { top: rect.bottom + 4 }
          : { bottom: window.innerHeight - rect.top + 4 }),
        ...(trigger !== undefined
          ? { minWidth: rect.width }
          : { width: rect.width }),
      }
    : {};
  if (trigger === undefined && rect) {
    posStyle.maxWidth = 260;
    (posStyle as { minWidth?: number }).minWidth = 120;
  }

  const itemBase = itemClassName ?? 'px-2 py-1.5 rounded-lg text-[11px] font-mono';
  const panelShape = panelClassName ?? 'rounded-xl p-1 space-y-0.5 max-h-52';

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        ref={btnRef}
        type="button"
        title={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        {...uiAttr}
        onClick={() => setOpen((v) => !v)}
        className={
          triggerClassName ??
          `w-full glass-input border rounded px-1.5 py-0.5 ${textCls} text-left cursor-pointer flex items-center justify-between text-[11px] font-mono ${
            open ? (accent === 'amber' ? 'border-amber-400/60' : 'border-cyan-400/60') : 'border-white/12'
          }`
        }
      >
        {trigger !== undefined ? (
          trigger
        ) : (
          <>
            <span className="truncate">{current?.label ?? ''}</span>
            <span className="text-white/40 text-[9px] shrink-0">▾</span>
          </>
        )}
      </button>
      {open && rect &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[60]" onMouseDown={() => setOpen(false)} />
            <div
              ref={popRef}
              {...uiAttr}
              className={`fixed z-[61] glass-panel-strong border-white/15 overflow-y-auto ${panelShape}`}
              style={posStyle}
            >
              {options.map((o) => {
                const active = value !== undefined && o.value === value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    {...uiAttr}
                    onClick={() => { onChange(o.value); setOpen(false); }}
                    className={`w-full flex items-center text-left transition cursor-pointer ${itemBase} ${
                      o.danger
                        ? 'text-red-300 hover:bg-red-500/15'
                        : active
                          ? selCls
                          : 'text-white/70 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    {o.icon && <span className="shrink-0 opacity-80 flex items-center">{o.icon}</span>}
                    <span className="block truncate">{o.label}</span>
                  </button>
                );
              })}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
