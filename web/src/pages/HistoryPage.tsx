import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { api, type TaskSummary } from '../lib/api';

const STATUS: Record<string, { label: string; cls: string }> = {
  planning: { label: '规划中', cls: 'bg-neutral-100 text-neutral-500' },
  awaiting_confirm: { label: '待确认', cls: 'bg-amber-100 text-amber-700' },
  generating: { label: '生成中', cls: 'bg-orange-100 text-orange-700' },
  exporting: { label: '导出中', cls: 'bg-orange-100 text-orange-700' },
  done: { label: '完成', cls: 'bg-green-100 text-green-700' },
  failed: { label: '失败', cls: 'bg-red-100 text-red-700' },
  cancelled: { label: '已取消', cls: 'bg-neutral-100 text-neutral-400' },
};

export default function HistoryPage() {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);

  useEffect(() => {
    api.listTasks().then((r) => setTasks(r.tasks)).catch(() => setTasks([]));
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-3 py-5 sm:px-6 sm:py-8">
      <h1 className="mb-6 text-2xl font-bold">我的任务</h1>
      {!tasks ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-neutral-300" /></div>
      ) : tasks.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-200 py-16 text-center text-sm text-neutral-400">
          还没有任务，<Link to="/create" className="text-orange-600">去创建一个</Link>
        </div>
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => {
            const s = STATUS[t.status] ?? { label: t.status, cls: 'bg-neutral-100 text-neutral-500' };
            return (
              <Link key={t.id} to={`/task/${t.id}`} className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 hover:border-orange-300">
                {t.status === 'done' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                  : t.status === 'failed' ? <XCircle className="h-4 w-4 shrink-0 text-red-500" />
                  : <Clock className="h-4 w-4 shrink-0 text-orange-500" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{t.topic || '(无主题)'}</div>
                  <div className="text-xs text-neutral-400">{new Date(t.created_at).toLocaleString()} · {t.mode}</div>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${s.cls}`}>{s.label}</span>
                {t.credits_cost > 0 && <span className="shrink-0 text-xs text-neutral-400">{t.credits_cost} 积分</span>}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
