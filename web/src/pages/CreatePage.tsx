import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, ListChecks, Wand2, Paintbrush, FileEdit, LayoutTemplate, ImagePlay, Coins, UploadCloud, X, Loader2, Globe, FileUp } from 'lucide-react';
import { api, type TemplateItem, type BuiltinTemplate, type UploadItem } from '../lib/api';

const MODES = [
  { id: 'generate', name: '生成 PPT', icon: ListChecks, desc: '主题/文档 → 确认大纲 → 逐页生成可编辑 PPTX', ready: true },
  { id: 'quick', name: '快速生成', icon: Zap, desc: '跳过确认，一步直出 PPTX', ready: true },
  { id: 'beautify', name: '美化 PPT', icon: Paintbrush, desc: '上传 PPTX → 保持页数/顺序/措辞，重新设计排版', ready: true },
  { id: 'edit_native', name: '编辑 PPT', icon: FileEdit, desc: '上传 PPTX → 保留原设计，按指令修改指定页', ready: true },
  { id: 'create_template', name: '创建模板', icon: LayoutTemplate, desc: '从参考 PPTX/图片蒸馏可复用的风格模板', ready: true },
  { id: 'image_to_pptx', name: '图片转 PPT', icon: ImagePlay, desc: '上传页面截图 → 逐页重建为可编辑 PPT', ready: true },
];

const FORMATS = [
  { id: 'ppt169', name: '16:9 宽屏' },
  { id: 'ppt43', name: '4:3 传统' },
];

const KIND_LABEL: Record<string, string> = { brand: '品牌', style: '风格', deck: '场景' };

/** 通用上传区 */
function UploadZone({ accept, multiple, label, file, files, onUpload, onRemove, busy }: {
  accept: string; multiple?: boolean; label: string;
  file?: UploadItem | null; files?: UploadItem[];
  onUpload: (fs: FileList | File[]) => void; onRemove: (id: string) => void; busy: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <div
        className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-4 py-2.5 text-sm text-neutral-500 hover:border-orange-300 hover:bg-orange-50/40"
        onClick={() => ref.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); onUpload(e.dataTransfer.files); }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin text-orange-500" /> : <UploadCloud className="h-4 w-4 text-neutral-400" />}
        {busy ? '上传中…' : label}
      </div>
      <input ref={ref} type="file" accept={accept} multiple={multiple} hidden onChange={(e) => e.target.files && onUpload(e.target.files)} />
      {file && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm">
          <FileUp className="h-4 w-4 text-green-500" />
          <span className="flex-1 truncate">{file.filename}</span>
          <button className="text-neutral-400 hover:text-red-500" onClick={() => onRemove(file.id)}><X className="h-4 w-4" /></button>
        </div>
      )}
      {files && files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {files.map((f) => (
            <div key={f.id} className="group relative h-16 w-24 overflow-hidden rounded-md border border-neutral-200">
              <img src={f.url} alt={f.filename} className="h-full w-full object-cover" />
              <button
                className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                onClick={() => onRemove(f.id)}
              ><X className="h-3 w-3" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CreatePage() {
  const nav = useNavigate();
  const [mode, setMode] = useState('generate');
  const [topic, setTopic] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [pages, setPages] = useState<number>(8);
  const [format, setFormat] = useState('ppt169');
  const [styleHint, setStyleHint] = useState('');
  const [language, setLanguage] = useState('中文');
  const [templateId, setTemplateId] = useState('');
  const [myTemplates, setMyTemplates] = useState<TemplateItem[]>([]);
  const [builtin, setBuiltin] = useState<BuiltinTemplate[]>([]);
  const [assets, setAssets] = useState<UploadItem[]>([]);
  const [research, setResearch] = useState(false);
  const [hasTavily, setHasTavily] = useState(false);

  // 4 条新路由的表单状态
  const [pptxFile, setPptxFile] = useState<UploadItem | null>(null);       // beautify / edit_native / create_template 参考稿
  const [instruction, setInstruction] = useState('');                       // beautify / edit_native / image_to_pptx
  const [tplName, setTplName] = useState('');                               // create_template
  const [tplDesc, setTplDesc] = useState('');                               // create_template
  const [shots, setShots] = useState<UploadItem[]>([]);                     // image_to_pptx 截图

  const [uploading, setUploading] = useState<null | 'asset' | 'pptx' | 'shot'>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listTemplates().then((r) => setMyTemplates(r.templates)).catch(() => {});
    api.listBuiltinTemplates().then((r) => setBuiltin(r.templates)).catch(() => {});
    api.getSettings().then((s) => setHasTavily(s.hasTavilyKey)).catch(() => {});
  }, []);

  const upload = async (kind: 'asset' | 'pptx' | 'shot', files: FileList | File[]) => {
    const list = [...files].filter((f) =>
      kind === 'pptx' ? (f.name.endsWith('.pptx') || f.type.includes('presentationml')) : f.type.startsWith('image/'));
    if (!list.length) { setError(kind === 'pptx' ? '请选择 .pptx 文件' : '请选择图片文件'); return; }
    setError('');
    setUploading(kind);
    try {
      const uploaded = await api.uploadAssets(list);
      if (kind === 'asset') setAssets((a) => [...a, ...uploaded].slice(0, 10));
      else if (kind === 'pptx') setPptxFile(uploaded[0] ?? null);
      else setShots((a) => [...a, ...uploaded].slice(0, 30));
    } catch (e: any) { setError(e.message); } finally { setUploading(null); }
  };

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      let input: any;
      if (mode === 'generate' || mode === 'quick') {
        input = {
          mode, topic, sourceText, pages, format, styleHint, language,
          templateId: templateId || null,
          assetIds: assets.map((a) => a.id),
          research: research && hasTavily,
        };
      } else if (mode === 'beautify') {
        input = { mode, fileId: pptxFile?.id, instruction };
      } else if (mode === 'edit_native') {
        input = { mode, fileId: pptxFile?.id, instruction };
      } else if (mode === 'create_template') {
        input = { mode, name: tplName, description: tplDesc, fileId: pptxFile?.id };
      } else {
        input = { mode, fileIds: shots.map((s) => s.id), instruction };
      }
      const { id } = await api.createTask(input);
      nav(`/task/${id}`);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  // 校验
  const canSubmit = (() => {
    if (busy || uploading) return false;
    if (mode === 'generate' || mode === 'quick') return !!(topic || sourceText);
    if (mode === 'beautify' || mode === 'edit_native') return !!pptxFile && (mode === 'beautify' || !!instruction);
    if (mode === 'create_template') return !!tplName.trim() && (!!pptxFile || !!tplDesc.trim());
    return shots.length > 0;
  })();

  const submitLabel = (() => {
    if (busy) return '创建中…';
    if (mode === 'quick') return '立即生成';
    if (mode === 'generate') return '生成大纲';
    if (mode === 'beautify') return '开始美化';
    if (mode === 'edit_native') return '开始编辑';
    if (mode === 'create_template') return '创建模板';
    return '开始重建';
  })();

  const est = mode === 'generate' || mode === 'quick'
    ? (pages === 0 ? 'AI 决定' : `${pages}+`)
    : mode === 'create_template' ? '0（免费）' : '按页计';

  const builtinGroups = (['deck', 'brand', 'style'] as const).map((k) => ({
    kind: k,
    items: builtin.filter((b) => b.kind === k),
  }));

  const isGenMode = mode === 'generate' || mode === 'quick';

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="mb-1 text-2xl font-bold">创建 PPT</h1>
      <p className="mb-4 text-sm text-neutral-500">AI 逐页手写矢量页面，导出为 PowerPoint 原生可编辑对象</p>

      {/* 模式选择 */}
      <div className="mb-2 grid grid-cols-6 gap-1.5">
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              onClick={() => { setMode(m.id); setError(''); }}
              title={m.desc}
              className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-2 transition-all ${
                active ? 'border-orange-400 bg-orange-50 ring-1 ring-orange-200' : 'border-neutral-200 bg-white hover:border-neutral-300'
              }`}
            >
              <Icon className={`h-4 w-4 ${active ? 'text-orange-600' : 'text-neutral-400'}`} />
              <span className={`text-[11px] leading-none ${active ? 'font-semibold text-orange-700' : 'text-neutral-600'}`}>{m.name}</span>
            </button>
          );
        })}
      </div>
      <p className="mb-5 text-xs text-neutral-400">{MODES.find((m) => m.id === mode)?.desc}</p>

      <div className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-6">
        {/* ==== 生成/快速 模式 === */}
        {isGenMode && (
          <>
            <div>
              <label className="mb-1.5 block text-sm font-medium">主题</label>
              <input className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                placeholder="例如：2026 年 Q3 业绩回顾、区块链入门、产品发布会…"
                value={topic} onChange={(e) => setTopic(e.target.value)} />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">源材料 <span className="font-normal text-neutral-400">（可选，粘贴文本，AI 忠于材料事实）</span></label>
              <textarea className="h-28 w-full resize-y rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                placeholder="粘贴报告/文章/笔记内容…" value={sourceText} onChange={(e) => setSourceText(e.target.value)} />
              {hasTavily && (
                <label className="mt-2 flex cursor-pointer select-none items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/50 px-3 py-2 text-xs text-blue-700">
                  <input type="checkbox" checked={research} onChange={(e) => setResearch(e.target.checked)} className="accent-blue-500" />
                  <Globe className="h-3.5 w-3.5" />
                  联网研究（Tavily）：规划前先搜索最新资料补充事实，适合时效性主题
                </label>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">图片素材 <span className="font-normal text-neutral-400">（可选，最多 10 张）</span></label>
              <UploadZone accept="image/*" multiple label="点击或拖拽图片（png/jpg/webp，单张 ≤ 20MB）"
                files={assets} busy={uploading === 'asset'}
                onUpload={(fs) => upload('asset', fs)}
                onRemove={(id) => setAssets((a) => a.filter((x) => x.id !== id))} />
            </div>
            <div className="grid grid-cols-4 gap-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium">页数</label>
                <select className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                  value={pages} onChange={(e) => setPages(Number(e.target.value))}>
                  <option value={0}>✨ AI 决定</option>
                  {[5, 6, 8, 10, 12, 15, 20, 30].map((n) => <option key={n} value={n}>{n} 页</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">画幅</label>
                <select className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                  value={format} onChange={(e) => setFormat(e.target.value)}>
                  {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">语言</label>
                <select className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                  value={language} onChange={(e) => setLanguage(e.target.value)}>
                  <option value="中文">中文</option>
                  <option value="English">English</option>
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">模板 <span className="font-normal text-neutral-400">（可选）</span></label>
                <select className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                  value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  <option value="">自由设计</option>
                  {myTemplates.length > 0 && (
                    <optgroup label="我的模板">{myTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>
                  )}
                  {builtinGroups.map((g) => g.items.length > 0 && (
                    <optgroup key={g.kind} label={`内置·${KIND_LABEL[g.kind]}`}>{g.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>
                  ))}
                </select>
              </div>
            </div>
            {templateId && (() => {
              const all: (TemplateItem | BuiltinTemplate)[] = [...myTemplates, ...builtin];
              const t = all.find((x) => x.id === templateId);
              if (!t) return null;
              const summary = 'summary' in t ? t.summary : (t as TemplateItem).description;
              const color = 'primaryColor' in t ? (t as BuiltinTemplate).primaryColor : (t.style as any).palette?.[0];
              return (
                <div className="flex items-start gap-2 rounded-lg bg-orange-50/60 px-3 py-2 text-xs text-neutral-600">
                  {color && <span className="mt-0.5 h-3 w-3 shrink-0 rounded-full border border-neutral-300" style={{ background: color }} />}
                  <span>{summary || '已选择模板，生成时将严格遵循其风格规范'}</span>
                </div>
              );
            })()}
            <div>
              <label className="mb-1.5 block text-sm font-medium">风格偏好 <span className="font-normal text-neutral-400">（可选，选择模板后由模板主导）</span></label>
              <input className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                placeholder="例如：商务深色数据风 / 杂志编辑风 / 瑞士网格…"
                value={styleHint} onChange={(e) => setStyleHint(e.target.value)} />
            </div>
          </>
        )}

        {/* ==== 美化 PPT === */}
        {mode === 'beautify' && (
          <>
            <UploadZone accept=".pptx" label="点击或拖拽要美化的 PPTX（页数、顺序、措辞将 1:1 保留）"
              file={pptxFile} busy={uploading === 'pptx'}
              onUpload={(fs) => upload('pptx', fs)}
              onRemove={() => setPptxFile(null)} />
            <div>
              <label className="mb-1.5 block text-sm font-medium">美化要求 <span className="font-normal text-neutral-400">（可选，如“更现代的排版”“深色商务风”）</span></label>
              <input className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                placeholder="留空则由 AI 自主重新设计每页排版"
                value={instruction} onChange={(e) => setInstruction(e.target.value)} />
            </div>
            <div className="rounded-lg bg-blue-50/60 px-3 py-2 text-xs text-blue-600">
              内容契约：AI 提取原 PPT 每页的文字（措辞冻结）后逐页重排视觉；图表与图片会重新绘制/排布。计费按实际页数（1 积分/页）。
            </div>
          </>
        )}

        {/* ==== 编辑 PPT（roundtrip） === */}
        {mode === 'edit_native' && (
          <>
            <UploadZone accept=".pptx" label="点击或拖拽要编辑的 PPTX（未修改的页将逐字节原样保留）"
              file={pptxFile} busy={uploading === 'pptx'}
              onUpload={(fs) => upload('pptx', fs)}
              onRemove={() => setPptxFile(null)} />
            <div>
              <label className="mb-1.5 block text-sm font-medium">编辑指令 * <span className="font-normal text-neutral-400">（AI 会规划要改哪些页）</span></label>
              <textarea className="h-24 w-full resize-y rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                placeholder="例如：把第 3 页的数据更新为 2026 年的；第 5 页加一页总结；替换所有提到 X 产品的地方为 Y"
                value={instruction} onChange={(e) => setInstruction(e.target.value)} />
            </div>
            <div className="rounded-lg bg-emerald-50/60 px-3 py-2 text-xs text-emerald-700">
              原生保留：只有被编辑的页会被重建，其余页面（含母版、动画、备注）逐字节还原。计费只收被编辑的页。
            </div>
          </>
        )}

        {/* ==== 创建模板 === */}
        {mode === 'create_template' && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium">模板名称 *</label>
                <input className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                  placeholder="例如：科技公司品牌风" value={tplName} onChange={(e) => setTplName(e.target.value)} />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">适用场景 <span className="font-normal text-neutral-400">（可选）</span></label>
                <input className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                  placeholder="例如：产品发布会、技术分享" value={tplDesc} onChange={(e) => setTplDesc(e.target.value)} />
              </div>
            </div>
            <UploadZone accept=".pptx,image/*" label="参考稿（可选）：上传 PPTX 或品牌图，AI 从中蒸馏配色/字体/风格规范"
              file={pptxFile} busy={uploading === 'pptx'}
              onUpload={(fs) => upload('pptx', fs)}
              onRemove={() => setPptxFile(null)} />
            <div className="rounded-lg bg-purple-50/60 px-3 py-2 text-xs text-purple-700">
              蒸馏结果保存到「我的模板」，创建 PPT 时可直接选用。免费（不消耗积分）。
            </div>
          </>
        )}

        {/* ==== 图片转 PPT === */}
        {mode === 'image_to_pptx' && (
          <>
            <UploadZone accept="image/*" multiple label="点击或拖拽页面截图（每张重建为一页，顺序按上传顺序）"
              files={shots} busy={uploading === 'shot'}
              onUpload={(fs) => upload('shot', fs)}
              onRemove={(id) => setShots((a) => a.filter((x) => x.id !== id))} />
            <div>
              <label className="mb-1.5 block text-sm font-medium">补充说明 <span className="font-normal text-neutral-400">（可选，截图里文字较多时建议说明主题）</span></label>
              <input className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                placeholder="例如：这是产品发布会的 5 页幻灯片"
                value={instruction} onChange={(e) => setInstruction(e.target.value)} />
            </div>
            <div className="rounded-lg bg-amber-50/60 px-3 py-2 text-xs text-amber-700">
              重建说明：截图作为参考层 + AI 重建原生文字与形状。文字识别质量取决于 chat 模型的多模态能力，复杂图形可能简化。
            </div>
          </>
        )}

        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}

        <div className="flex items-center justify-between border-t border-neutral-100 pt-4">
          <div className="flex items-center gap-1.5 text-sm text-neutral-500">
            <Coins className="h-4 w-4 text-amber-500" />
            预计 <span className="font-medium text-neutral-700">{est} 积分</span>
            <span className="text-xs text-neutral-400">（1 积分/页，AI 配图每张 +1，完成后多退少补）</span>
          </div>
          <button
            className="flex items-center gap-2 rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
            disabled={!canSubmit}
            onClick={submit}
          >
            <Wand2 className="h-4 w-4" />
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
