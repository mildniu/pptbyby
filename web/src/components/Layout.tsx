import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Presentation, Sparkles, History, Settings, ShieldUser, ClipboardList, LogOut, Coins } from 'lucide-react';
import { useApp } from '../stores/app';

const linkCls = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
    isActive ? 'bg-orange-100 text-orange-700 font-medium' : 'text-neutral-600 hover:bg-neutral-100'
  }`;

export default function Layout() {
  const user = useApp((s) => s.user);
  const logout = useApp((s) => s.logout);
  const nav = useNavigate();

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-neutral-200 bg-white px-3 py-4">
        <div className="mb-6 flex items-center gap-2 px-2">
          <Presentation className="h-6 w-6 text-orange-600" />
          <span className="text-lg font-bold tracking-tight">PPTByBy</span>
        </div>
        <nav className="flex flex-col gap-1">
          <NavLink to="/create" className={linkCls}><Sparkles className="h-4 w-4" />创建 PPT</NavLink>
          <NavLink to="/history" className={linkCls}><History className="h-4 w-4" />我的任务</NavLink>
          <NavLink to="/settings" className={linkCls}><Settings className="h-4 w-4" />网关设置</NavLink>
          {user?.role === 'admin' && (
            <>
              <NavLink to="/admin/users" className={linkCls}><ShieldUser className="h-4 w-4" />用户管理</NavLink>
              <NavLink to="/admin/tasks" className={linkCls}><ClipboardList className="h-4 w-4" />全部任务</NavLink>
            </>
          )}
        </nav>
        <div className="mt-auto flex items-center justify-between rounded-lg bg-neutral-50 px-3 py-2">
          <div className="text-xs text-neutral-500">
            <div className="font-medium text-neutral-700">{user?.username}</div>
            <div className="mt-0.5 flex items-center gap-1"><Coins className="h-3 w-3 text-amber-500" />{user?.credits ?? 0} 积分</div>
          </div>
          <button
            className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600"
            title="退出登录"
            onClick={async () => { await logout(); nav('/login'); }}
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
