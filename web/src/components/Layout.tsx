import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Presentation, Sparkles, History, LayoutTemplate, Settings, ShieldUser, ClipboardList, LogOut, Coins, Menu, X,
} from 'lucide-react';
import { useApp } from '../stores/app';

export default function Layout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const nav = useNavigate();
  const user = useApp((s) => s.user);
  const logout = useApp((s) => s.logout);

  const navMain = [
    { to: '/create', label: '创作', icon: Sparkles },
    { to: '/history', label: '任务', icon: History },
    { to: '/templates', label: '模板', icon: LayoutTemplate },
  ];
  const navBottom = [
    ...(user?.role === 'admin'
      ? [
          { to: '/admin/users', label: '用户', icon: ShieldUser },
          { to: '/admin/tasks', label: '记录', icon: ClipboardList },
        ]
      : []),
    { to: '/settings', label: '设置', icon: Settings },
  ];

  const handleLogout = async () => {
    await logout();
    nav('/login');
  };

  return (
    <div className="flex min-h-full flex-col bg-[#faf9f7] text-neutral-950">
      {/* 桌面端窄侧栏 (w-14) */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-14 flex-col items-center border-r border-neutral-200 bg-white lg:flex">
        <button
          type="button"
          onClick={() => nav('/create')}
          className="mt-3 grid h-9 w-9 place-items-center rounded-full transition hover:bg-neutral-100"
          title="PPTByBy"
        >
          <Presentation className="h-6 w-6 text-orange-600" />
        </button>
        <nav className="mt-6 flex flex-1 flex-col items-center gap-2">
          {navMain.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                title={item.label}
                className={({ isActive }) =>
                  `grid h-10 w-10 place-items-center rounded-full transition ${
                    isActive ? 'bg-neutral-950 text-white shadow-sm' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950'
                  }`
                }
              >
                <Icon size={18} />
              </NavLink>
            );
          })}
        </nav>
        <div className="mb-3 flex flex-col items-center gap-2">
          {navBottom.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                title={item.label}
                className={({ isActive }) =>
                  `grid h-10 w-10 place-items-center rounded-full transition ${
                    isActive ? 'bg-neutral-950 text-white shadow-sm' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950'
                  }`
                }
              >
                <Icon size={18} />
              </NavLink>
            );
          })}
          <button
            type="button"
            onClick={handleLogout}
            className="grid h-10 w-10 place-items-center rounded-full text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900"
            title="退出登录"
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>

      {/* 顶部 Header */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-neutral-200 bg-white/95 px-2.5 backdrop-blur sm:px-4 lg:ml-14">
        <button
          type="button"
          aria-label={mobileMenuOpen ? '关闭菜单' : '打开菜单'}
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-neutral-700 hover:bg-neutral-100 lg:hidden"
        >
          {mobileMenuOpen ? <X size={19} /> : <Menu size={19} />}
        </button>
        <button type="button" onClick={() => nav('/create')} className="flex items-center gap-2 rounded-full px-1 py-1">
          <Presentation className="h-6 w-6 text-orange-600" />
          <span className="hidden text-[15px] font-medium tracking-tight sm:inline">PPTByBy</span>
        </button>
        <div className="ml-4 hidden min-w-0 flex-1 items-center gap-1.5 overflow-x-auto lg:flex">
          {[...navMain, ...navBottom].map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition ${
                    isActive ? 'bg-neutral-950 font-medium text-white' : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900'
                  }`
                }
              >
                <Icon size={14} />{item.label}
              </NavLink>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] text-neutral-700 sm:text-xs">
            <Coins className="h-3.5 w-3.5 text-amber-500" />
            <span className="max-w-[16vw] truncate sm:max-w-none">{user?.username}</span>
            <span className="shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium text-white">{user?.credits ?? 0}</span>
          </div>
        </div>
      </header>

      {/* 手机端抽屉菜单 */}
      {mobileMenuOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={() => setMobileMenuOpen(false)} />
          <div className="fixed inset-y-0 left-0 z-50 flex w-[min(70vw,280px)] flex-col border-r border-neutral-200 bg-white p-4 shadow-2xl lg:hidden">
            <div className="mb-4 flex items-center gap-2">
              <Presentation className="h-6 w-6 text-orange-600" />
              <span className="font-semibold">PPTByBy</span>
            </div>
            <nav className="flex flex-col gap-1">
              {[...navMain, ...navBottom].map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={() => setMobileMenuOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
                        isActive ? 'bg-orange-50 font-medium text-orange-700' : 'text-neutral-600 hover:bg-neutral-50'
                      }`
                    }
                  >
                    <Icon size={17} />{item.label}
                  </NavLink>
                );
              })}
            </nav>
            <button
              onClick={handleLogout}
              className="mt-auto flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-neutral-400 hover:bg-neutral-50 hover:text-neutral-900"
            >
              <LogOut size={17} />退出登录
            </button>
          </div>
        </>
      )}

      <main className="flex-1 pb-16 lg:ml-14 lg:pb-0">
        <Outlet />
      </main>

      {/* 手机端底部 Tab */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-neutral-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {[...navMain, { to: '/settings', label: '设置', icon: Settings }].map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition ${
                  isActive ? 'font-medium text-neutral-950' : 'text-neutral-400'
                }`
              }
            >
              <Icon size={18} />
              {item.label}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
