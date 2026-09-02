import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../lib/api';

export default function AdminUsersPage() {
  const [users, setUsers] = useState<any[] | null>(null);

  const load = () => api.adminUsers().then((r) => setUsers(r.users)).catch(() => setUsers([]));
  useEffect(() => { load(); }, []);

  if (!users) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-neutral-300" /></div>;

  return (
    <div className="mx-auto max-w-4xl px-3 py-5 sm:px-6 sm:py-8">
      <h1 className="mb-6 text-2xl font-bold">用户管理</h1>
      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white"><table className="w-full text-sm">
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
            <tr key={u.id} className="border-t border-neutral-100">
              <td className="px-4 py-3 font-medium">{u.username}</td>
              <td className="px-4 py-3 text-neutral-500">{u.role}</td>
              <td className="px-4 py-3">
                <span className={`rounded-full px-2 py-0.5 text-xs ${u.status === 1 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                  {u.status === 1 ? '正常' : '禁用'}
                </span>
              </td>
              <td className="px-4 py-3">
                <input
                  type="number" defaultValue={u.credits}
                  className="w-20 rounded border border-neutral-200 px-2 py-1 text-xs"
                  onBlur={async (e) => {
                    const v = Number(e.target.value);
                    if (v !== u.credits) { await api.adminUpdateUser(u.id, { credits: v }); load(); }
                  }}
                />
              </td>
              <td className="px-4 py-3 text-xs text-neutral-400">{new Date(u.created_at).toLocaleDateString()}</td>
              <td className="px-4 py-3">
                <button
                  className="rounded border border-neutral-200 px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-50"
                  onClick={async () => { await api.adminUpdateUser(u.id, { status: u.status !== 1 }); load(); }}
                >
                  {u.status === 1 ? '禁用' : '启用'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}
