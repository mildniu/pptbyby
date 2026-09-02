import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  CheckCircle2, XCircle, Loader2, Download, Check, Pencil, Trash2, Coins, AlertTriangle,
  CircleDashed, Clock, Image as ImageIcon, ListTree, FileCheck2, Package, ChevronRight,
} from 'lucide-react';
import { api, type TaskDetail, type StepProgress } from '../lib/api';

const STATUS_LABEL: Record<string, string> = {
  planning: '规划大纲中',
  awaiting_confirm: '待确认大纲',
  generating: '逐页生成中',
  exporting: '导出中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const STEP_ICONS: Record<string, any> = {
  plan: ListTree,
  assets: ImageIcon,
  pages: Package,
  inspect: FileCheck2,
  export: Download,
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
    <div className="slide-frame aspect-video overflow-hidden rounded-lg border border-neutral-200 bg-white" dangerouslySetInnerHTML={{ __html: svg }} />
  );
}

function fmtDur(step: StepProgress): string {
  if (!step.startedAt) return '';
  const end = step.endedAt ?? Date.now();
  const s = Math.round((end - step.startedAt) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function StepStatusIcon({ status }: { status: StepProgress['status'] }) {
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />;
  if (status === 'failed') return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
  if (status === 'running') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-orange-500" />;
  if (status === 'skipped') return <CircleDashed className="h-4 w-4 shrink-0 text-neutral-300" />;
  return <CircleDashed className="h-4 w-4 shrink-0 text-neutral-300" />;
}

export default function TaskPage() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editPages, setEditPages] = useState('');
  const [activeStep, setActiveStep] = useState<string>('pages');
  const pollRef = useRef<number | null>(null);

  const load = async () => {
    try {
      const t = await api.getTask(id!);
      setTask(t);
      if (t.spec) { setEditTitle(t.spec.title); setEditPages(t.spec.pages.map((p) => `${p.title}||${p.outline}`).join('\n')); }
      // 自动跟随运行中的步骤
      const run = t.progress?.steps?.find((s) => s.status === 'running');
      if (run) setActiveStep(run.key);
      else if (t.status === 'awaiting_confirm') setActiveStep('plan');
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
    }, 2500);
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
  const steps = prog?.steps ?? [];
  const donePages = prog?.pages?.filter((p) => p.status === 'ok').length ?? 0;
  const activeSpec = task.spec;
  const tplName = null; // 模板名暂不展示（spec.templateId 未带名称）

  // 步骤面板内容
  const stepPanel = () => {
    switch (activeStep) {
      case 'plan':
        return (
          <div>
            {task.status === 'planning' && (
              <div className="flex flex-col items-center py-10">
                <Loader2 className="mb-3 h-7 w-7 animate-spin text-orange-500" />
                <div className="text-sm text-neutral-500">AI 正在规划大纲与设计方向…</div>
              </div>
            )}
            {task.status === 'awaiting_confirm' && activeSpec && !editing && (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-neutral-100 px-2.5 py-1">模式：{activeSpec.style.mode}</span>
                  {activeSpec.style.palette.map((c) => (
                    <span key={c} className="flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-1">
                      <span className="h-3 w-3 rounded-full border border-neutral-300" style={{ background: c }} />{c}
                    </span>
                  ))}
                </div>
                <ol className="space-y-1.5">
                  {activeSpec.pages.map((p, i) => (
                    <li key={p.id} className="rounded-lg border border-neutral-100 bg-neutral-50 px-4 py-2.5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-mono text-neutral-400">{String(i + 1).padStart(2, '0')}</span>
                        <span className="text-sm font-medium">{p.title}</span>
                        <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-neutral-400">{p.role}</span>
                      </div>
                      <p className="mt-1 pl-7 text-xs leading-relaxed text-neutral-500">{p.outline}</p>
                    </li>
                  ))}
                </ol>
                {activeSpec.images.length > 0 && (
                  <div className="mt-3 rounded-lg bg-amber-50 px-4 py-2.5 text-xs text-amber-700">
                    计划 {activeSpec.images.filter((i) => i.origin === 'user').length} 张用户素材
                    {activeSpec.images.filter((i) => i.origin !== 'user').length > 0 && ` + AI 生成 ${activeSpec.images.filter((i) => i.origin !== 'user').length} 张配图（每张 1 积分）`}
                    ：{activeSpec.images.map((i) => `${i.origin === 'user' ? '素材' : 'AI'}·${i.usage}`).join('；')}
                  </div>
                )}
              </>
            )}
            {editing && (
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
            {['generating', 'exporting', 'done', 'failed'].includes(task.status) && activeSpec && (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                  <span className="rounded-full bg-neutral-100 px-2.5 py-1">{activeSpec.style.mode}</span>
                  <span className="text-xs">{activeSpec.style.notes}</span>
                </div>
                <ol className="space-y-1.5">
                  {activeSpec.pages.map((p, i) => (
                    <li key={p.id} className="rounded-lg border border-neutral-100 bg-neutral-50 px-4 py-2.5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-mono text-neutral-400">{String(i + 1).padStart(2, '0')}</span>
                        <span className="text-sm">{p.title}</span>
                        <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-neutral-400">{p.role}</span>
                      </div>
                      <p className="mt-1 pl-7 text-xs leading-relaxed text-neutral-500">{p.outline}</p>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        );
      case 'assets':
        return (
          <div>
            {task.images.length === 0 ? (
              <div className="flex flex-col items-center py-10 text-sm text-neutral-400">
                <ImageIcon className="mb-2 h-7 w-7 text-neutral-300" />
                {steps.find((s) => s.key === 'assets')?.status === 'skipped' ? '本任务没有配图素材' : '素材准备中…'}
              </div>
            ) : (
              <>
                <div className="mb-3 text-xs text-neutral-500">
                  {task.images.length} 张素材 · AI 配图每张 1 积分，用户上传素材不收费
                </div>
                <div className="grid grid-cols-4 gap-3">
                  {task.images.map((im) => {
                    const spec = activeSpec?.images.find((s) => s.file === im.file);
                    const st = spec?.status ?? 'done';
                    return (
                      <div key={im.file} className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
                        <div className="relative aspect-video bg-neutral-100">
                          <img src={im.url} alt={im.file} className="h-full w-full object-cover" />
                          {st === 'generating' && (
                            <div className="absolute inset-0 flex items-center justify-center bg-white/60">
                              <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
                            </div>
                          )}
                          {st === 'failed' && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-50/80 text-[10px] text-red-500">
                              <XCircle className="mb-1 h-4 w-4" />生成失败
                            </div>
                          )}
                        </div>
                        <div className="px-2 py-1.5 text-[11px] text-neutral-500">
                          <div className="truncate" title={spec?.usage || im.file}>{spec?.usage || im.file}</div>
                          <div className="mt-0.5 flex items-center gap-1 text-neutral-400">
                            {spec?.origin === 'user' ? <span className="rounded bg-blue-50 px-1 text-blue-500">用户素材</span> : <span className="rounded bg-purple-50 px-1 text-purple-500">AI 生成</span>}
                            {st === 'done' || st === 'ready' ? <CheckCircle2 className="h-3 w-3 text-green-500" /> : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        );
      case 'pages':
        return (
          <div>
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
                        {p?.retries ? <span className="rounded bg-amber-50 px-1 text-amber-600" title={(p.attempts ?? []).join('\n')}>重试{p.retries}</span> : null}
                        {p?.title && <span className="truncate">{p.title}</span>}
                      </div>
                      {p?.error && <div className="mt-0.5 truncate text-[11px] text-red-400" title={p.error}>{p.error}</div>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center py-10">
                <Loader2 className="mb-3 h-7 w-7 animate-spin text-orange-500" />
                <div className="text-sm text-neutral-500">{prog?.message ?? '准备中…'}</div>
              </div>
            )}
          </div>
        );
      case 'inspect':
        return (
          <div className="space-y-3">
            {steps.find((s) => s.key === 'inspect')?.status === 'pending' && (
              <div className="py-6 text-center text-sm text-neutral-400">尚未开始（逐页生成完成后进行）</div>
            )}
            {(() => {
              const st = steps.find((s) => s.key === 'inspect');
              if (!st || st.status === 'pending') return null;
              return (
                <div className={`rounded-lg px-4 py-3 text-sm ${st.status === 'done' ? 'bg-green-50 text-green-700' : st.status === 'failed' ? 'bg-red-50 text-red-600' : 'bg-orange-50 text-orange-700'}`}>
                  {st.status === 'done' ? '✓ 质量终检通过，所有页面符合规范' : st.message}
                </div>
              );
            })()}
            {/* 每页质检详情 */}
            <div className="space-y-2">
              {(prog?.pages ?? []).map((p, i) => (
                <details key={p.id} className="rounded-lg border border-neutral-100 bg-neutral-50 px-4 py-2.5" open={p.status === 'failed'}>
                  <summary className="flex cursor-pointer items-center gap-2 text-sm">
                    <StepStatusIcon status={p.status === 'ok' ? 'done' : p.status === 'failed' ? 'failed' : 'running'} />
                    <span className="font-mono text-xs text-neutral-400">{String(i + 1).padStart(2, '0')}</span>
                    <span>{p.title}</span>
                    {p.retries ? <span className="rounded bg-amber-50 px-1.5 text-xs text-amber-600">{p.retries} 次重试</span> : null}
                    <ChevronRight className="ml-auto h-3.5 w-3.5 rotate-90 text-neutral-300" />
                  </summary>
                  <div className="mt-2 space-y-1.5 pl-6">
                    {(p.attempts ?? []).map((a, j) => (
                      <div key={j} className="rounded bg-white px-3 py-1.5 text-xs leading-relaxed text-neutral-500">{a}</div>
                    ))}
                    {!p.attempts?.length && <div className="text-xs text-green-600">一次通过</div>}
                    {p.error && <div className="rounded bg-red-50 px-3 py-1.5 text-xs text-red-500">{p.error}</div>}
                  </div>
                </details>
              ))}
            </div>
          </div>
        );
      case 'export':
        return (
          <div>
            {(() => {
              const st = steps.find((s) => s.key === 'export');
              if (!st || st.status === 'pending') return <div className="py-6 text-center text-sm text-neutral-400">尚未开始</div>;
              if (st.status === 'running') return (
                <div className="flex flex-col items-center py-10">
                  <Loader2 className="mb-3 h-7 w-7 animate-spin text-orange-500" />
                  <div className="text-sm text-neutral-500">正在编译为原生 PPTX…</div>
                </div>
              );
              if (st.status === 'failed') return <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{st.message}</div>;
              return (
                <div className="flex items-center justify-between rounded-xl bg-green-50 px-5 py-4">
                  <div className="text-sm text-green-700">
                    导出完成：{st.message} · 共 {task.slides.length} 页原生可编辑 PPTX
                  </div>
                  {task.downloadUrl && (
                    <a href={task.downloadUrl} className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">
                      <Download className="h-4 w-4" />下载 PPTX
                    </a>
                  )}
                </div>
              );
            })()}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      {/* 头部 */}
      <div className="mb-5 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold">{activeSpec?.title || task.topic || '未命名任务'}</h1>
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

      {/* 大纲确认操作条 */}
      {task.status === 'awaiting_confirm' && activeSpec && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-5 py-3">
          <div className="text-sm text-amber-700">大纲已就绪，确认后开始生成（可在「规划大纲」步骤中编辑）</div>
          <div className="flex gap-2">
            <button onClick={() => setEditing(!editing)} className="flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-100">
              <Pencil className="h-3.5 w-3.5" />{editing ? '放弃编辑' : '编辑大纲'}
            </button>
            <button onClick={() => confirm()} className="flex items-center gap-1 rounded-lg bg-orange-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-orange-700">
              <Check className="h-3.5 w-3.5" />确认并生成（{activeSpec.pages.length + activeSpec.images.filter((i) => i.origin !== 'user').length} 积分）
            </button>
          </div>
        </div>
      )}

      {/* 进行中总进度条 */}
      {active && prog?.totalPages ? (
        <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm text-orange-700">
            <Loader2 className="h-4 w-4 animate-spin" />
            {prog.message || STATUS_LABEL[task.status]}
            <span className="ml-auto text-xs">{donePages}/{prog.totalPages} 页</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-orange-100">
            <div className="h-full rounded-full bg-orange-500 transition-all" style={{ width: `${(donePages / prog.totalPages) * 100}%` }} />
          </div>
        </div>
      ) : null}

      {/* 步骤时间线 + 面板 */}
      <div className="flex gap-5">
        {/* 左：步骤列表（可点） */}
        <div className="w-52 shrink-0 space-y-1.5">
          {steps.map((s) => {
            const Icon = STEP_ICONS[s.key] ?? CircleDashed;
            const isActive = activeStep === s.key;
            return (
              <button
                key={s.key}
                onClick={() => setActiveStep(s.key)}
                className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  isActive ? 'border-orange-300 bg-orange-50' : 'border-neutral-200 bg-white hover:bg-neutral-50'
                }`}
              >
                <StepStatusIcon status={s.status} />
                <div className="min-w-0 flex-1">
                  <div className={`text-sm ${isActive ? 'font-semibold text-orange-800' : 'text-neutral-700'}`}>{s.label}</div>
                  {s.message && <div className="truncate text-[11px] leading-tight text-neutral-400" title={s.message}>{s.message}</div>}
                </div>
                {s.status === 'running' && fmtDur(s) ? <span className="text-[10px] tabular-nums text-orange-400">{fmtDur(s)}</span> : null}
                {s.status === 'done' && s.endedAt && s.startedAt ? <span className="text-[10px] tabular-nums text-neutral-400">{fmtDur(s)}</span> : null}
                <Icon className="hidden" />
              </button>
            );
          })}
        </div>

        {/* 右：当前步骤素材面板 */}
        <div className="min-w-0 flex-1 rounded-2xl border border-neutral-200 bg-white p-5">
          <div className="mb-4 flex items-center gap-2 border-b border-neutral-100 pb-3">
            {(() => { const Icon = STEP_ICONS[activeStep] ?? ListTree; return <Icon className="h-4 w-4 text-orange-500" />; })()}
            <h2 className="text-sm font-semibold">{steps.find((s) => s.key === activeStep)?.label ?? '详情'}</h2>
            <span className="ml-auto flex items-center gap-1 text-[11px] text-neutral-400"><Clock className="h-3 w-3" />{fmtDur(steps.find((s) => s.key === activeStep)!)}</span>
          </div>
          {stepPanel()}
        </div>
      </div>

      {task.status === 'done' && (
        <div className="mt-5 flex items-center justify-between rounded-xl bg-green-50 px-5 py-3.5">
          <div className="text-sm text-green-700">
            完成！共 {task.slides.length} 页，消耗 {task.creditsCost} 积分。{task.error ? `（${task.error}）` : ''}
            <button
              className="ml-2 text-xs text-green-600 underline hover:text-green-700"
              onClick={async () => {
                const name = activeSpec?.title || task.topic || '新模板';
                await api.createTemplate({ name, style: activeSpec?.style, coverSvg: undefined });
                alert('已保存为模板，可在「模板库」中管理');
              }}
            >存为模板</button>
          </div>
          {task.downloadUrl && (
            <a href={task.downloadUrl} className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">
              <Download className="h-4 w-4" />下载 PPTX
            </a>
          )}
        </div>
      )}
      {task.status === 'failed' && (
        <div className="mt-5 rounded-xl bg-red-50 px-5 py-3.5 text-sm text-red-600">{task.error ?? '生成失败'} <Link to="/create" className="ml-2 underline">重新创建</Link></div>
      )}
      {task.status === 'cancelled' && (
        <div className="mt-5 rounded-xl bg-neutral-100 px-5 py-3.5 text-sm text-neutral-500">任务已取消，预扣积分已退还。<Link to="/create" className="text-orange-600">再建一个</Link></div>
      )}
    </div>
  );
}
