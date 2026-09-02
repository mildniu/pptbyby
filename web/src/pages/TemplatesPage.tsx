import { useEffect, useState } from 'react';
import { Loader2, Plus, Pencil, Trash2, X, Palette, Type, StickyNote } from 'lucide-react';
import { api, type TemplateItem } from '../lib/api';

interface TemplateForm {
  name: string;
  description: string;
  mode: string;
  paletteText: string; // 逗号分隔
  typography: string;
  notes: string;
}

const EMPTY_FORM: TemplateForm = { name: '', description: '', mode: '', paletteText: '', typography: '', notes: '' };

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

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateItem[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; form: TemplateForm } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.listTemplates().then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing) return;
    const f = editing.form;
    if (!f.name.trim()) { setError('模板名称必填'); return; }
    const palette = f.paletteText.split(/[,，\s]+/).filter((s) => s && !/^#[0-9A-Fa-f]{6}$/.test(s));
    if (palette.length) { setError(`调色板含非法颜色：${palette.join(' ')}（需 #RRGGBB 格式）`); return; }
    setError('');
    setBusy(true);
    try {
      const style = styleFromForm(f);
      if (editing.id) await api.updateTemplate(editing.id, { name: f.name, description: f.description, style });
      else await api.createTemplate({ name: f.name, description: f.description, style });
      setEditing(null);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">模板库</h1>
          <p className="mt-0.5 text-sm text-neutral-500">保存风格规范（视觉模式 / 配色 / 字阶 / 一致性说明），创建 PPT 时可直接套用</p>
        </div>
        <button
          className="flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700"
          onClick={() => { setEditing({ id: null, form: { ...EMPTY_FORM } }); setError(''); }}
        >
          <Plus className="h-4 w-4" />新建模板
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

      {/* 模板列表 */}
      {!templates ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-neutral-300" /></div>
      ) : templates.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-200 py-16 text-center text-sm text-neutral-400">
          还没有模板。点击右上角「新建模板」，或在完成的任务里点「存为模板」。
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {templates.map((t) => (
            <div key={t.id} className="rounded-2xl border border-neutral-200 bg-white p-5">
              <div className="mb-2 flex items-start justify-between">
                <div>
                  <div className="font-semibold">{t.name}</div>
                  <div className="mt-0.5 text-xs text-neutral-400">{t.description || t.style?.mode || '—'} · {t.created_by_name ?? (t.created_by === 'admin' ? 'admin' : '用户')} 创建</div>
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
          ))}
        </div>
      )}
    </div>
  );
}
