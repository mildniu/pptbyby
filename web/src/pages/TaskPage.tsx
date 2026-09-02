import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { CheckCircle2, XCircle, Loader2, Download, RefreshCw, Check, Pencil, Trash2, Coins, AlertTriangle } from 'lucide-react';
import { api, type TaskDetail } from '../lib/api';

const STATUS_LABEL: Record<string, string> = {
  planning: '规划大纲中',
  awaiting_confirm: '待确认大纲',
  generating: '逐页生成中',
  exporting: '导出中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function SlidePreview({ url }: { url: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url, { credentials: 'include' })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((t) => alive && setSvg(t))
      .catch(() => alive && setSvg(null));
    return () => { alive = false; };
  }, [url]);
  if (!svg) return <div className="flex aspect-video items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-xs text-neutral-400">加载预览…</div>;
  return (
    <div
      className="slide-frame aspect-video overflow-hidden rounded-lg border border-neutral-200 bg-white"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export default function TaskPage() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editPages, setEditPages] = useState('');
  const pollRef = useRef<number | null>(null);

  const load = async () => {
    try {
      const t = await api.getTask(id!);
      setTask(t);
      if (t.spec) { setEditTitle(t.spec.title); setEditPages(t.spec.pages.map((p) => `${p.title}||${p.outline}`).join('\n')); }
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load();
    pollRef.current = window.setInterval(() => {
      setTask((t) => {
        if (t && ['done', 'failed', 'cancelled'].includes(t.status)) return t;
        load();
        return t;
      });
    }, 3000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [id]);

  if (error) return <div className="p-8 text-sm text-red-600">{error}</div>;
  if (!task) return <div className="p-8 text-sm text-neutral-400">加载中…</div>;

  const confirm = async (spec?: any) => {
    try {
      await api.confirmTask(task.id, spec);
      setEditing(false);
      load();
    } catch (e: any) { setError(e.message); }
  };

  const buildEditedSpec = () => {
    const spec = JSON.parse(JSON.stringify(task.spec));
    const lines = editPages.split('\n').filter((l) => l.trim());
    spec.title = editTitle.trim() || spec.title;
    spec.pages = lines.map((line, i) => {
      const [title, ...rest] = line.split('||');
      const prev = spec.pages[i];
      return { id: prev?.id ?? `p${String(i + 1).padStart(2, '0')}`, role: prev?.role ?? 'content', title: title.trim(), outline: rest.join('||').trim() };
    });
    return spec;
  };

  const active = ['planning', 'awaiting_confirm', 'generating', 'exporting'].includes(task.status);
  const prog = task.progress;
  const donePages = prog?.pages?.filter((p) => p.status === 'ok').length ?? 0;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      {/* 头部 */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold">{task.spec?.title || task.topic || '未命名任务'}</h1>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              task.status === 'done' ? 'bg-green-100 text-green-700'
              : task.status === 'failed' ? 'bg-red-100 text-red-700'
              : active ? 'bg-orange-100 text-orange-700' : 'bg-neutral-100 text-neutral-500'
            }`}>{STATUS_LABEL[task.status] ?? task.status}</span>
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs text-neutral-400">
            <span>{new Date(task.createdAt).toLocaleString()}</span>
            <span className="flex items-center gap-1"><Coins className="h-3 w-3 text-amber-500" />{task.creditsCost || task.creditsHeld} 积分</span>
            {task.error && <span className="flex items-center gap-1 text-red-500"><AlertTriangle className="h-3 w-3" />{task.error}</span>}
          </div>
        </div>
        <div className="flex gap-2">
          {task.downloadUrl && (
            <a href={task.downloadUrl} className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">
              <Download className="h-4 w-4" />下载 PPTX
            </a>
          )}
          {active && task.status !== 'planning' && (
            <button onClick={() => api.cancelTask(task.id).then(load)} className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-600 hover:bg-neutral-50">取消任务</button>
          )}
          {!active && (
            <button onClick={() => api.deleteTask(task.id).then(() => history.back())} className="rounded-lg border border-neutral-200 p-2 text-neutral-400 hover:bg-red-50 hover:text-red-500" title="删除任务">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* 规划中 */}
      {task.status === 'planning' && (
        <div className="flex flex-col items-center rounded-2xl border border-neutral-200 bg-white py-16">
          <Loader2 className="mb-3 h-8 w-8 animate-spin text-orange-500" />
          <div className="text-sm text-neutral-500">AI 正在规划大纲与设计方向…</div>
        </div>
      )}

      {/* 待确认：大纲 */}
      {task.status === 'awaiting_confirm' && task.spec && (
        <div className="rounded-2xl border border-neutral-200 bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">大纲确认 <span className="text-xs font-normal text-neutral-400">（确认后开始生成，按页预扣积分）</span></h2>
            <div className="flex gap-2">
              <button onClick={() => setEditing(!editing)} className="flex items-center gap-1 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50">
                <Pencil className="h-3.5 w-3.5" />{editing ? '放弃编辑' : '编辑大纲'}
              </button>
              <button onClick={() => confirm()} className="flex items-center gap-1 rounded-lg bg-orange-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-orange-700">
                <Check className="h-3.5 w-3.5" />确认并生成（{task.spec.pages.length} 页 · {task.spec.pages.length + task.spec.images.length} 积分）
              </button>
            </div>
          </div>

          {!editing ? (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full bg-neutral-100 px-2.5 py-1">模式：{task.spec.style.mode}</span>
                {task.spec.style.palette.map((c) => (
                  <span key={c} className="flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-1">
                    <span className="h-3 w-3 rounded-full border border-neutral-300" style={{ background: c }} />{c}
                  </span>
                ))}
              </div>
              <ol className="space-y-2">
                {task.spec.pages.map((p, i) => (
                  <li key={p.id} className="rounded-lg border border-neutral-100 bg-neutral-50 px-4 py-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-mono text-neutral-400">{String(i + 1).padStart(2, '0')}</span>
                      <span className="text-sm font-medium">{p.title}</span>
                      <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-neutral-400">{p.role}</span>
                    </div>
                    <p className="mt-1 pl-7 text-xs leading-relaxed text-neutral-500">{p.outline}</p>
                  </li>
                ))}
              </ol>
              {task.spec.images.length > 0 && (
                <div className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-xs text-amber-700">
                  计划 AI 生成 {task.spec.images.length} 张配图（每张额外 1 积分）：{task.spec.images.map((i) => i.usage).join('；')}
                </div>
              )}
            </>
          ) : (
            <div>
              <input
                className="mb-3 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm font-medium outline-none focus:border-orange-400"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="演示标题"
              />
              <textarea
                className="mb-3 h-72 w-full resize-y rounded-lg border border-neutral-200 px-3 py-2 font-mono text-xs outline-none focus:border-orange-400"
                value={editPages}
                onChange={(e) => setEditPages(e.target.value)}
                placeholder="每行一页：标题||内容要点描述"
              />
              <button onClick={() => confirm(buildEditedSpec())} className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700">保存并生成</button>
            </div>
          )}
        </div>
      )}

      {/* 生成中 / 完成：逐页进度与预览 */}
      {(task.status === 'generating' || task.status === 'exporting' || task.status === 'done' || task.status === 'failed') && (
        <div>
          {active && (
            <div className="mb-5 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-orange-700">
                <Loader2 className="h-4 w-4 animate-spin" />
                {prog?.message ?? STATUS_LABEL[task.status]}
                <span className="ml-auto text-xs">{donePages}/{prog?.totalPages ?? '?'} 页</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-orange-100">
                <div className="h-full rounded-full bg-orange-500 transition-all" style={{ width: `${prog?.totalPages ? (donePages / prog.totalPages) * 100 : 0}%` }} />
              </div>
            </div>
          )}

          {task.slides.length > 0 ? (
            <div className="grid grid-cols-2 gap-4">
              {task.slides.map((s) => {
                const p = prog?.pages?.find((x) => x.id === `p${String(s.page).padStart(2, '0')}`);
                return (
                  <div key={s.page}>
                    <SlidePreview url={s.svg} />
                    <div className="mt-1.5 flex items-center gap-1.5 text-xs text-neutral-400">
                      第 {s.page} 页
                      {p?.status === 'ok' && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                      {p?.status === 'failed' && <XCircle className="h-3.5 w-3.5 text-red-500" />}
                      {p?.retries ? <span className="text-amber-500">重试{p.retries}次</span> : null}
                      {p?.title && <span className="truncate">{p.title}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center rounded-2xl border border-neutral-200 bg-white py-16">
              <Loader2 className="mb-3 h-8 w-8 animate-spin text-orange-500" />
              <div className="text-sm text-neutral-500">{prog?.message ?? '准备中…'}</div>
            </div>
          )}

          {task.status === 'done' && (
            <div className="mt-6 flex items-center justify-between rounded-xl bg-green-50 px-5 py-4">
              <div className="text-sm text-green-700">
                完成！共 {task.slides.length} 页，消耗 {task.creditsCost} 积分。
                {task.error ? `（${task.error}）` : ''}
              </div>
              {task.downloadUrl && (
                <a href={task.downloadUrl} className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">
                  <Download className="h-4 w-4" />下载 PPTX
                </a>
              )}
            </div>
          )}
          {task.status === 'failed' && (
            <div className="mt-6 rounded-xl bg-red-50 px-5 py-4 text-sm text-red-600">{task.error ?? '生成失败'}</div>
          )}
        </div>
      )}

      {task.status === 'cancelled' && (
        <div className="rounded-xl bg-neutral-100 px-5 py-4 text-sm text-neutral-500">任务已取消，预扣积分已退还。<Link to="/create" className="text-orange-600">再建一个</Link></div>
      )}
    </div>
  );
}
