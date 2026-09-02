import { useEffect, useState } from 'react';
import { Loader2, UserPlus, Pencil, KeyRound, X } from 'lucide-react';
import { api } from '../lib/api';

interface UserRow {
  id: string;
  username: string;
  role: string;
  status: number;
  credits: number;
  created_at: number;
}

interface EditForm {
  id: string | null; // null = 新建
  username: string;
  password: string;
  credits: string;
  role: string;
}

const EMPTY: EditForm = { id: null, username: '', password: '', credits: '20', role: 'user' };

export default function AdminUsersPage() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [editing, setEditing] = useState<EditForm | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [newPw, setNewPw] = useState('');

  const load = () => api.adminUsers().then((r) => setUsers(r.users as any)).catch(() => setUsers([]));
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing) return;
    const f = editing;
    if (!f.username.trim()) { setError('用户名必填'); return; }
    if (f.id === null && f.password.length < 4) { setError('新用户密码至少 4 位'); return; }
    setError('');
    setBusy(true);
    try {
      if (f.id === null) {
        await api.adminCreateUser({ username: f.username.trim(), password: f.password, credits: Number(f.credits) || 0, role: f.role });
      } else {
        await api.adminUpdateUser(f.id, { username: f.username.trim(), credits: Number(f.credits) || 0, role: f.role });
      }
      setEditing(null);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const resetPw = async () => {
    if (!pwFor || newPw.length < 4) { setError('新密码至少 4 位'); return; }
    setError(''); setBusy(true);
    try {
      await api.adminResetPassword(pwFor, newPw);
      setPwFor(null); setNewPw('');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (!users) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-neutral-300" /></div>;

  return (
    <div className="mx-auto max-w-4xl px-3 py-5 sm:px-6 sm:py-8">
      <div className="mb-4 flex items-start justify-between gap-3 sm:mb-6">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">用户管理</h1>
          <p className="mt-0.5 hidden text-sm text-neutral-500 sm:block">创建用户、编辑资料与积分、重置密码、启用/禁用</p>
        </div>
        <button
          className="flex shrink-0 items-center gap-1 rounded-lg bg-orange-600 px-3 py-2 text-xs font-medium text-white hover:bg-orange-700 sm:gap-1.5 sm:px-4 sm:text-sm"
          onClick={() => { setEditing({ ...EMPTY }); setError(''); setPwFor(null); }}
        >
          <UserPlus className="h-4 w-4" /><span className="hidden sm:inline">新建用户</span>
        </button>
      </div>

      {/* 编辑/新建表单 */}
      {editing && (
        <div className="mb-5 rounded-2xl border border-orange-200 bg-orange-50/50 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-orange-800">{editing.id === null ? '新建用户' : '编辑用户'}</h2>
            <button className="rounded p-1 text-neutral-400 hover:bg-white" onClick={() => setEditing(null)}><X className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600">用户名 *</label>
              <input className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                value={editing.username}
                onChange={(e) => setEditing({ ...editing, username: e.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600">角色</label>
              <select className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </select>
            </div>
            {editing.id === null && (
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">初始密码 *（≥4 位）</label>
                <input type="password" className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                  value={editing.password}
                  onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600">积分</label>
              <input type="number" min={0} className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                value={editing.credits}
                onChange={(e) => setEditing({ ...editing, credits: e.target.value })} />
            </div>
          </div>
          {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
          <div className="mt-4 flex justify-end gap-2">
            <button className="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-50" onClick={() => setEditing(null)}>取消</button>
            <button className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50" disabled={busy} onClick={save}>
              {busy ? '保存中…' : editing.id === null ? '创建用户' : '保存修改'}
            </button>
          </div>
        </div>
      )}

      {/* 重置密码表单 */}
      {pwFor && (
        <div className="mb-5 rounded-2xl border border-blue-200 bg-blue-50/50 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-blue-800">重置密码（{users.find((u) => u.id === pwFor)?.username ?? ''}）</h2>
            <button className="rounded p-1 text-neutral-400 hover:bg-white" onClick={() => { setPwFor(null); setNewPw(''); }}><X className="h-4 w-4" /></button>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input type="password" autoFocus placeholder="新密码（≥4 位）" className="flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400"
              value={newPw} onChange={(e) => setNewPw(e.target.value)} />
            <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" disabled={busy} onClick={resetPw}>
              {busy ? '重置中…' : '确认重置'}
            </button>
          </div>
        </div>
      )}

      {/* 用户表 */}
      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
            <tr>
              <th className="px-4 py-3">用户名</th>
              <th className="px-4 py-3">角色</th>
              <th className="px-4 py-3">状态</th>
              <th className="px-4 py-3">积分</th>
              <th className="px-4 py-3">注册时间</th>
              <th className="px-4 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-neutral-100 hover:bg-neutral-50">
                <td className="px-4 py-3 font-medium">{u.username}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${u.role === 'admin' ? 'bg-purple-50 text-purple-600' : 'bg-neutral-100 text-neutral-500'}`}>
                    {u.role === 'admin' ? '管理员' : '用户'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${u.status === 1 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                    {u.status === 1 ? '正常' : '禁用'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <input
                    type="number" min={0} defaultValue={u.credits}
                    className="w-20 rounded border border-neutral-200 px-2 py-1 text-xs"
                    onBlur={async (e) => {
                      const v = Number(e.target.value);
                      if (v !== u.credits) { await api.adminUpdateUser(u.id, { credits: v }); load(); }
                    }}
                  />
                </td>
                <td className="px-4 py-3 text-xs text-neutral-400">{new Date(u.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    <button className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="编辑"
                      onClick={() => { setEditing({ id: u.id, username: u.username, password: '', credits: String(u.credits), role: u.role }); setError(''); setPwFor(null); }}>
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button className="rounded-md p-1.5 text-neutral-400 hover:bg-blue-50 hover:text-blue-600" title="重置密码"
                      onClick={() => { setPwFor(u.id); setNewPw(''); setEditing(null); }}>
                      <KeyRound className="h-3.5 w-3.5" />
                    </button>
                    <button className="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-50"
                      onClick={async () => { await api.adminUpdateUser(u.id, { status: u.status !== 1 }); load(); }}
                    >{u.status === 1 ? '禁用' : '启用'}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && !editing && !pwFor && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
    </div>
  );
}
