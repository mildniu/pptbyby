import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../lib/api';

const STATUS: Record<string, string> = {
  planning: '规划中', awaiting_confirm: '待确认', generating: '生成中', exporting: '导出中',
  done: '完成', failed: '失败', cancelled: '已取消',
};

export default function AdminTasksPage() {
  const [tasks, setTasks] = useState<any[] | null>(null);

  useEffect(() => {
    api.adminTasks().then((r) => setTasks(r.tasks)).catch(() => setTasks([]));
    const t = window.setInterval(() => api.adminTasks().then((r) => setTasks(r.tasks)).catch(() => {}), 10000);
    return () => window.clearInterval(t);
  }, []);

  if (!tasks) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-neutral-300" /></div>;

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="mb-6 text-2xl font-bold">全部任务</h1>
      <table className="w-full overflow-hidden rounded-xl border border-neutral-200 bg-white text-sm">
        <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
          <tr>
            <th className="px-4 py-3">用户</th>
            <th className="px-4 py-3">模式</th>
            <th className="px-4 py-3">主题</th>
            <th className="px-4 py-3">状态</th>
            <th className="px-4 py-3">积分</th>
            <th className="px-4 py-3">时间</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} className="border-t border-neutral-100">
              <td className="px-4 py-3">{t.username ?? t.user_id}</td>
              <td className="px-4 py-3 text-neutral-500">{t.mode}</td>
              <td className="max-w-xs truncate px-4 py-3">{t.topic || '-'}</td>
              <td className="px-4 py-3">{STATUS[t.status] ?? t.status}</td>
              <td className="px-4 py-3">{t.credits_cost}</td>
              <td className="px-4 py-3 text-xs text-neutral-400">{new Date(t.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
