import { useEffect, useState } from 'react';
import { Loader2, Plus, Pencil, Trash2, X, Palette, Type, StickyNote, BookOpen, Maximize2 } from 'lucide-react';
import { api, type TemplateItem, type BuiltinTemplate } from '../lib/api';

interface TemplateForm {
  name: string;
  description: string;
  mode: string;
  paletteText: string; // 逗号分隔
  typography: string;
  notes: string;
}

const EMPTY_FORM: TemplateForm = { name: '', description: '', mode: '', paletteText: '', typography: '', notes: '' };
const KIND_LABEL: Record<string, string> = { brand: '品牌', style: '风格', deck: '场景' };
const KIND_DESC: Record<string, string> = {
  brand: '品牌识别：色板 / 字体 / 语气规范',
  style: '叙事方法：页面角色 / 论证结构 / 图表纪律',
  deck: '完整场景：页面原型 + 品牌素材 + 规范',
};

function formFromTpl(t: TemplateItem): TemplateForm {
  return {
    name: t.name,
    description: t.description ?? '',
    mode: t.style?.mode ?? '',
    paletteText: (t.style?.palette ?? []).join(', '),
    typography: t.style?.typography ?? '',
    notes: t.style?.notes ?? '',
  };
}

function styleFromForm(f: TemplateForm) {
  return {
    mode: f.mode.trim(),
    palette: f.paletteText.split(/[,，\s]+/).map((s) => s.trim()).filter((s) => /^#[0-9A-Fa-f]{6}$/.test(s)),
    typography: f.typography.trim(),
    notes: f.notes.trim(),
  };
}

/** 内置模板卡片（只读，含参考图） */
function BuiltinCard({ t, onPreview }: { t: BuiltinTemplate; onPreview: (list: { url: string; title: string }[], index: number) => void }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-5">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{t.name}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${
              t.kind === 'brand' ? 'bg-purple-50 text-purple-600' : t.kind === 'style' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'
            }`}>{KIND_LABEL[t.kind]}</span>
          </div>
          <div className="mt-1 max-w-md text-xs leading-relaxed text-neutral-400" title={t.summary}>{t.summary}</div>
        </div>
        {t.primaryColor && (
          <span className="mt-1 flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-500">
            <span className="h-3 w-3 rounded-full border border-neutral-300" style={{ background: t.primaryColor }} />{t.primaryColor}
          </span>
        )}
      </div>
      <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
        {/* 无参考图时展示程序化风格示意 */}
        {!t.refImages.length && t.previewUrl && (
          <div className="group relative h-20 w-32 shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50"
            onClick={() => onPreview([{ url: t.previewUrl, title: t.name }], 0)}>
            <img src={t.previewUrl} alt={t.name} className="h-full w-full object-cover" />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/20 group-hover:opacity-100">
              <Maximize2 className="h-4 w-4 text-white" />
            </div>
          </div>
        )}
        {t.refImages.map((img, idx) => (
            <div key={img.url} className="group relative h-20 w-32 shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50"
              onClick={() => onPreview(t.refImages.map((im) => ({ url: im.url, title: `${t.name} · ${im.name}` })), idx)}>
              {img.url.endsWith('.svg') ? (
                <img src={img.url} alt={img.name} className="h-full w-full object-contain" />
              ) : (
                <img src={img.url} alt={img.name} className="h-full w-full object-cover" />
              )}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/20 group-hover:opacity-100">
                <Maximize2 className="h-4 w-4 text-white" />
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateItem[] | null>(null);
  const [builtin, setBuiltin] = useState<BuiltinTemplate[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; form: TemplateForm } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ list: { url: string; title: string }[]; index: number } | null>(null);
  const openPreview = (list: { url: string; title: string }[], index: number) => setPreview({ list, index });
  const stepPreview = (delta: number) => {
    setPreview((pv) => (pv ? { ...pv, index: (pv.index + delta + pv.list.length) % pv.list.length } : pv));
  };
  const [tab, setTab] = useState<'builtin' | 'mine'>('builtin');

  const load = () => api.listTemplates().then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));
  useEffect(() => {
    load();
    api.listBuiltinTemplates().then((r) => setBuiltin(r.templates)).catch(() => {});
  }, []);

  const save = async () => {
    if (!editing) return;
    const f = editing.form;
    if (!f.name.trim()) { setError('模板名称必填'); return; }
    const bad = f.paletteText.split(/[,，\s]+/).filter((s) => s && !/^#[0-9A-Fa-f]{6}$/.test(s));
    if (bad.length) { setError(`调色板含非法颜色：${bad.join(' ')}（需 #RRGGBB 格式）`); return; }
    setError('');
    setBusy(true);
    try {
      const style = styleFromForm(f);
      if (editing.id) await api.updateTemplate(editing.id, { name: f.name, description: f.description, style });
      else await api.createTemplate({ name: f.name, description: f.description, style });
      setEditing(null);
      setTab('mine');
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const builtinGroups = (['deck', 'brand', 'style'] as const).map((k) => ({ kind: k, items: builtin.filter((b) => b.kind === k) }));

  return (
    <div className="mx-auto max-w-4xl px-3 py-5 sm:px-6 sm:py-8">
      <div className="mb-4 flex items-start justify-between gap-3 sm:mb-5">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">模板库</h1>
          <p className="mt-0.5 hidden text-sm text-neutral-500 sm:block">内置专业模板（场景 / 品牌 / 风格），也可自建</p>
        </div>
        <button
          className="flex shrink-0 items-center gap-1 rounded-lg bg-orange-600 px-3 py-2 text-xs font-medium text-white hover:bg-orange-700 sm:gap-1.5 sm:px-4 sm:text-sm"
          onClick={() => { setEditing({ id: null, form: { ...EMPTY_FORM } }); setError(''); setTab('mine'); }}
        >
          <Plus className="h-4 w-4" /><span className="hidden sm:inline">新建模板</span>
        </button>
      </div>

      {/* Tab */}
      <div className="mb-4 flex gap-1 rounded-xl bg-neutral-100 p-1 text-sm">
        <button className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 transition-colors ${tab === 'builtin' ? 'bg-white font-medium shadow-sm' : 'text-neutral-500 hover:text-neutral-700'}`}
          onClick={() => setTab('builtin')}>
          <BookOpen className="h-4 w-4" />内置模板（{builtin.length}）
        </button>
        <button className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 transition-colors ${tab === 'mine' ? 'bg-white font-medium shadow-sm' : 'text-neutral-500 hover:text-neutral-700'}`}
          onClick={() => setTab('mine')}>
          <Palette className="h-4 w-4" />我的模板（{templates?.length ?? 0}）
        </button>
      </div>

      {/* 编辑器 */}
      {editing && (
        <div className="mb-5 rounded-2xl border border-orange-200 bg-orange-50/50 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-orange-800">{editing.id ? '编辑模板' : '新建模板'}</h2>
            <button className="rounded p-1 text-neutral-400 hover:bg-white" onClick={() => setEditing(null)}><X className="h-4 w-4" /></button>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">名称 *</label>
                <input className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                  placeholder="例如：商务深色数据风" value={editing.form.name}
                  onChange={(e) => setEditing({ ...editing, form: { ...editing.form, name: e.target.value } })} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">视觉模式</label>
                <input className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                  placeholder="例如：dark-data / swiss-grid / editorial" value={editing.form.mode}
                  onChange={(e) => setEditing({ ...editing, form: { ...editing.form, mode: e.target.value } })} />
              </div>
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs font-medium text-neutral-600"><Palette className="h-3 w-3" />调色板（#RRGGBB，逗号分隔，3-5 个）</label>
              <input className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-orange-400"
                placeholder="#0D1117, #F5F5F5, #3B82F6, #F59E0B" value={editing.form.paletteText}
                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, paletteText: e.target.value } })} />
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs font-medium text-neutral-600"><Type className="h-3 w-3" />字体策略（层级 / 对比 / 密度）</label>
              <input className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                placeholder="例如：大标题 64-88px 粗体，正文 18-22px，克制的两档字阶" value={editing.form.typography}
                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, typography: e.target.value } })} />
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs font-medium text-neutral-600"><StickyNote className="h-3 w-3" />跨页一致性说明</label>
              <textarea className="h-16 w-full resize-y rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                placeholder="例如：强调色仅用于数据高亮与关键结论；每页统一左上角 kicker 标签…" value={editing.form.notes}
                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, notes: e.target.value } })} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600">描述</label>
              <input className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-orange-400"
                placeholder="一句话说明适用场景" value={editing.form.description}
                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, description: e.target.value } })} />
            </div>
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <button className="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-50" onClick={() => setEditing(null)}>取消</button>
              <button className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50" disabled={busy} onClick={save}>
                {busy ? '保存中…' : '保存模板'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 内置模板 */}
      {tab === 'builtin' && (
        !builtin.length ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-neutral-300" /></div>
        ) : (
          <div className="space-y-6">
            {builtinGroups.map((g) => g.items.length > 0 && (
              <div key={g.kind}>
                <div className="mb-2.5 flex items-baseline gap-2">
                  <h2 className="text-sm font-semibold">{KIND_LABEL[g.kind]}模板</h2>
                  <span className="text-xs text-neutral-400">{KIND_DESC[g.kind]} · {g.items.length} 个</span>
                </div>
                <div className="grid grid-cols-1 gap-3">
                  {g.items.map((t) => <BuiltinCard key={t.id} t={t} onPreview={openPreview} />)}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* 我的模板 */}
      {tab === 'mine' && (
        !templates ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-neutral-300" /></div>
        ) : templates.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-neutral-200 py-16 text-center text-sm text-neutral-400">
            还没有自定义模板。点击右上角「新建模板」，或在完成的任务里点「存为模板」。
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
            {templates.map((t) => (
              <div key={t.id} className="overflow-hidden rounded-2xl border border-neutral-200 bg-white">
                {/* 预览图（点击放大；deck 类多页原型可翻页） */}
                {t.coverSvgUrl && (
                  <div className="group relative aspect-video cursor-zoom-in overflow-hidden border-b border-neutral-100 bg-neutral-50"
                    onClick={() => {
                      const n = Math.max(1, t.pageCount ?? 1);
                      const list = Array.from({ length: n }, (_, i) => ({
                        url: n > 1 ? `/api/templates/${t.id}/pages/${i}` : t.coverSvgUrl!,
                        title: `${t.name} · 第 ${i + 1}/${n} 页`,
                      }));
                      setPreview({ list, index: 0 });
                    }}>
                    <img src={t.coverSvgUrl} alt={t.name} className="absolute inset-0 h-full w-full object-cover" />
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/20 group-hover:opacity-100">
                      <Maximize2 className="h-6 w-6 text-white" />
                    </div>
                    {(t.pageCount ?? 0) > 1 && (
                      <span className="absolute right-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">场景方案 · {(t.pageCount)} 页原型</span>
                    )}
                    {t.kind === 'deck' && (t.pageCount ?? 0) <= 1 && (
                      <span className="absolute right-2 top-2 rounded bg-emerald-600/90 px-1.5 py-0.5 text-[10px] text-white">场景方案</span>
                    )}
                  </div>
                )}
                <div className="p-5">
                  <div className="mb-2 flex items-start justify-between">
                    <div>
                      <div className="font-semibold">{t.name}</div>
                      <div className="mt-0.5 text-xs text-neutral-400">{t.description || t.style?.mode || '—'}</div>
                    </div>
                    <div className="flex gap-1">
                      <button className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600" title="编辑"
                        onClick={() => { setEditing({ id: t.id, form: formFromTpl(t) }); setError(''); }}>
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button className="rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-500" title="删除"
                        onClick={async () => { if (confirm(`删除模板「${t.name}」？`)) { await api.deleteTemplate(t.id); load(); } }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="mb-3 flex flex-wrap items-center gap-1.5">
                    {(t.style?.palette ?? []).length ? (
                      t.style.palette.map((c) => (
                        <span key={c} className="flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-500">
                          <span className="h-3 w-3 rounded-full border border-neutral-300" style={{ background: c }} />{c}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-neutral-300">未设置调色板</span>
                    )}
                  </div>
                  {t.style?.typography && <div className="text-xs leading-relaxed text-neutral-500">{t.style.typography}</div>}
                  {t.style?.notes && <div className="mt-1 text-xs leading-relaxed text-neutral-400">{t.style.notes}</div>}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* 参考图预览（左右翻页） */}
      {preview && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/80 p-6 backdrop-blur-sm" onClick={() => setPreview(null)}
          onKeyDown={undefined}>
          <div className="mb-3 flex items-center justify-between text-white/80">
            <span className="text-sm">{preview.list[preview.index].title}（{preview.index + 1}/{preview.list.length}）</span>
            <button className="rounded-lg p-1.5 hover:bg-white/10" onClick={() => setPreview(null)}><X className="h-5 w-5" /></button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center gap-6" onClick={(e) => e.stopPropagation()}>
            <button className="rounded-full bg-white/10 p-3 text-2xl text-white/70 hover:bg-white/20" onClick={() => stepPreview(-1)}>‹</button>
            <img src={preview.list[preview.index].url} alt={preview.list[preview.index].title} className="max-h-full max-w-full rounded-xl bg-white p-2 shadow-2xl" />
            <button className="rounded-full bg-white/10 p-3 text-2xl text-white/70 hover:bg-white/20" onClick={() => stepPreview(1)}>›</button>
          </div>
          <div className="mt-3 flex justify-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            {preview.list.map((_, i) => (
              <button key={i} className={`h-1.5 rounded-full transition-all ${i === preview.index ? 'w-6 bg-white' : 'w-1.5 bg-white/30'}`} onClick={() => setPreview({ ...preview, index: i })} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
