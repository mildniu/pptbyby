import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';

export interface Option {
  value: string;
  label: string;
  badge?: string;
  cost?: number;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
  wide?: boolean;
  placeholder?: string;
}

export function PillSelect({
  value,
  options,
  onChange,
  disabled,
  wide,
  placeholder = '请选择',
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width?: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value) ?? options[0];

  // 打开菜单前实测触发按钮的视口坐标，fixed 弹层据此定位（解决移动端被 overflow 容器裁剪）
  const toggleMenu = () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const rect = ref.current?.getBoundingClientRect();
    if (rect) {
      const isMobile = window.innerWidth < 640;
      const menuWidth = wide ? 240 : 150;
      // 移动端：贴屏幕左右留 12px 边距全宽展示；桌面端：与按钮左对齐（不超出屏幕右侧）
      const left = isMobile
        ? 12
        : Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12));
      setMenuPos({
        top: rect.bottom + 8,
        left,
        width: isMobile ? window.innerWidth - 24 : undefined,
      });
    }
    setOpen(true);
  };

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return; // 触发按钮区域交给 onClick toggle
      if (menuRef.current?.contains(target)) return; // 菜单内部点击不关闭
      setOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
    };
  }, [open]);

  // 页面滚动或窗口尺寸变化时关闭菜单，避免 fixed 弹层与按钮错位（菜单内部滚动除外）
  useEffect(() => {
    if (!open) return;
    const handleScrollOrResize = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [open]);

  // 打开状态下若位置尚未测量（极端时序），补一次测量
  useLayoutEffect(() => {
    if (open && !menuPos) {
      const rect = ref.current?.getBoundingClientRect();
      if (rect) {
        setMenuPos({ top: rect.bottom + 8, left: 12, width: window.innerWidth - 24 });
      }
    }
  }, [open, menuPos]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={toggleMenu}
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-normal text-sky-600 outline-none transition sm:text-sm',
          wide && 'w-[124px] justify-between sm:w-[160px]',
          open ? 'bg-sky-50' : 'hover:bg-neutral-100',
          disabled && 'cursor-not-allowed text-neutral-400 hover:bg-transparent'
        )}
      >
        <span className={cn('whitespace-nowrap flex items-center gap-1', wide && 'min-w-0 truncate text-left')}>
          <span className="truncate">{selected?.label ?? placeholder}</span>
          {selected?.cost ? (
            <span className="shrink-0 rounded bg-sky-100/80 px-1 py-0.2 text-[10px] font-medium leading-tight text-sky-700">
              {selected.cost}分
            </span>
          ) : null}
        </span>
        <ChevronDown size={14} className={cn('shrink-0 transition-transform duration-200', open && 'rotate-180')} />
      </button>

      {open && !disabled && menuPos && (
        <div
          ref={menuRef}
          style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
          className={cn(
            'fixed z-[60] max-h-[min(60vh,320px)] overflow-y-auto rounded-[18px] border border-neutral-200 bg-white p-1.5 shadow-[0_18px_50px_rgba(15,23,42,.20)] no-scrollbar',
            wide ? 'min-w-[220px]' : 'min-w-[132px]'
          )}
        >
          {options.map((opt) => {
            const isCur = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={opt.disabled}
                onClick={() => {
                  if (!opt.disabled) {
                    onChange(opt.value);
                    setOpen(false);
                  }
                }}
                className={cn(
                  'flex h-10 w-full items-center justify-between gap-2 rounded-[12px] px-3 text-left text-[13px] transition sm:h-9 sm:text-sm',
                  isCur ? 'bg-neutral-100 font-medium text-neutral-950' : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-950',
                  opt.disabled && 'cursor-not-allowed text-neutral-300 hover:bg-transparent'
                )}
              >
                <span className="truncate">{opt.label}</span>
                {opt.cost ? (
                  <span className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium',
                    opt.cost >= 3 ? 'bg-purple-100 text-purple-700' : opt.cost === 2 ? 'bg-sky-100 text-sky-700' : 'bg-emerald-100 text-emerald-700'
                  )}>
                    {opt.cost} 积分
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
