import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Upload, ArrowUp, Loader2, X, Globe, FileUp, Paperclip } from 'lucide-react';
import { api, type TemplateItem, type BuiltinTemplate, type UploadItem } from '../lib/api';
import { PillSelect, type Option } from '../components/PillSelect';

/** 内联渲染一张 SVG（deck 页面原型），失败显示占位 */
function InlineSvg({ url, className }: { url: string; className?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url, { credentials: 'include' })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((t) => alive && setSvg(t))
      .catch(() => alive && setSvg(null));
    return () => { alive = false; };
  }, [url]);
  if (!svg) return <div className={className ? `${className} bg-neutral-50` : 'bg-neutral-50'} />;
  return <div className={className} style={{ position: 'relative' }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

const KIND_TAG: Record<string, { label: string; cls: string }> = {
  deck: { label: '场景', cls: 'bg-emerald-50 text-emerald-600' },
  brand: { label: '品牌', cls: 'bg-purple-50 text-purple-600' },
  style: { label: '风格', cls: 'bg-blue-50 text-blue-600' },
};

const MODES = [
  { id: 'generate', name: '生成', desc: '主题 → 确认大纲 → 逐页生成可编辑 PPTX' },
  { id: 'quick', name: '快速', desc: '跳过确认，一步直出 PPTX' },
  { id: 'beautify', name: '美化', desc: '上传 PPTX，保持页数/顺序/措辞重排视觉' },
  { id: 'edit_native', name: '编辑', desc: '上传 PPTX，保留原设计只改指定页' },
  { id: 'create_template', name: '蒸馏模板', desc: '从参考 PPTX/图片蒸馏可复用风格模板' },
  { id: 'image_to_pptx', name: '图转 PPT', desc: '页面截图逐页重建为可编辑 PPT' },
];

const KIND_LABEL: Record<string, string> = { brand: '品牌', style: '风格', deck: '场景' };

const PAGE_OPTS: Option[] = [
  { value: '0', label: '页数 AI 定' },
  ...[5, 6, 8, 10, 12, 15, 20, 30].map((n) => ({ value: String(n), label: `${n} 页` })),
];

const FORMAT_OPTS: Option[] = [
  { value: 'ppt169', label: '16:9 宽屏' },
  { value: 'ppt43', label: '4:3 传统' },
];

const LANG_OPTS: Option[] = [
  { value: '中文', label: '中文' },
  { value: 'English', label: 'English' },
];

const IMAGE_MODE_OPTS: Option[] = [
  { value: 'auto', label: '配图 AI 定' },
  { value: 'none', label: '无配图' },
  { value: 'every', label: '每页配图' },
];

/** 通用上传：pptx 或图片 */
function useUploader() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [pptx, setPptx] = useState<UploadItem | null>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | File[], kind: 'image' | 'pptx' | 'shots') => {
    const list = [...files].filter((f) =>
      kind === 'pptx' ? (f.name.endsWith('.pptx') || f.type.includes('presentationml')) : f.type.startsWith('image/'));
    if (!list.length) return null;
    setBusy(true);
    try {
      const uploaded = await api.uploadAssets(list);
      if (kind === 'pptx') setPptx(uploaded[0] ?? null);
      else setItems((a) => [...a, ...uploaded].slice(0, kind === 'shots' ? 30 : 10));
      return uploaded;
    } finally { setBusy(false); }
  };
  return { items, setItems, pptx, setPptx, busy, upload };
}

export default function CreatePage() {
  const nav = useNavigate();
  const [mode, setMode] = useState('generate');
  const [topic, setTopic] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [pages, setPages] = useState('0');
  const [format, setFormat] = useState('ppt169');
  const [language, setLanguage] = useState('中文');
  const [templateId, setTemplateId] = useState('auto');
  const [research, setResearch] = useState(false);
  const [imageMode, setImageMode] = useState('auto');
  const [hasTavily, setHasTavily] = useState(false);

  const [myTemplates, setMyTemplates] = useState<TemplateItem[]>([]);
  const [builtin, setBuiltin] = useState<BuiltinTemplate[]>([]);

  // 上传状态（按模式复用）
  const assets = useUploader();   // 生成模式的图片素材
  const srcFile = useUploader();  // beautify/edit/create_template 的源 PPTX/图
  const shots = useUploader();    // image_to_pptx 截图
  const [instruction, setInstruction] = useState('');
  const [tplName, setTplName] = useState('');
  const [tplKind, setTplKind] = useState<'style' | 'deck'>('deck');
  const [tplDesc, setTplDesc] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const shotRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.listTemplates().then((r) => setMyTemplates(r.templates)).catch(() => {});
    api.listBuiltinTemplates().then((r) => setBuiltin(r.templates)).catch(() => {});
    api.getSettings().then((s) => setHasTavily(s.hasTavilyKey)).catch(() => {});
  }, []);

  const isGenMode = mode === 'generate' || mode === 'quick';

  // 模板选项：AI 适配置顶 + 我的 + 内置（场景→品牌→风格）
  const tplOptions: Option[] = [
    { value: 'auto', label: '模板 AI 定' },
    ...myTemplates.map((t) => ({ value: t.id, label: t.name, badge: '我的' })),
    ...(['deck', 'brand', 'style'] as const).flatMap((k) =>
      builtin.filter((b) => b.kind === k).map((b) => ({ value: b.id, label: b.name, badge: KIND_LABEL[k] }))),
  ];

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      let input: any;
      if (isGenMode) {
        input = {
          mode, topic, sourceText, pages: Number(pages), format, language,
          templateId: templateId && templateId !== 'auto' ? templateId : null,
          assetIds: assets.items.map((a) => a.id),
          research,
          imageMode,
        };
      } else if (mode === 'beautify') {
        input = { mode, fileId: srcFile.pptx?.id, instruction };
      } else if (mode === 'edit_native') {
        input = { mode, fileId: srcFile.pptx?.id, instruction };
      } else if (mode === 'create_template') {
        input = { mode, name: tplName, description: tplDesc, fileId: srcFile.pptx?.id, templateKind: tplKind };
      } else {
        input = { mode, fileIds: shots.items.map((s) => s.id), instruction };
      }
      const { id } = await api.createTask(input);
      nav(`/task/${id}`);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  const canSubmit = (() => {
    if (busy || assets.busy || srcFile.busy || shots.busy) return false;
    if (isGenMode) return !!(topic || sourceText);
    if (mode === 'beautify') return !!srcFile.pptx;
    if (mode === 'edit_native') return !!srcFile.pptx && !!instruction.trim();
    if (mode === 'create_template') return !!tplName.trim() && (!!srcFile.pptx || !!tplDesc.trim());
    return shots.items.length > 0;
  })();

  const submitLabel = mode === 'quick' ? '立即生成' : mode === 'generate' ? '生成大纲' : mode === 'beautify' ? '开始美化' : mode === 'edit_native' ? '开始编辑' : mode === 'create_template' ? '创建模板' : '开始重建';

  return (
    <div className="mx-auto min-h-full w-full max-w-[900px] px-4 pb-16 pt-6 sm:px-8 sm:pt-10">
      {/* 模式切换（小 tab 药丸） */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {MODES.map((m) => (
          <button
            key={m.id}
            title={m.desc}
            onClick={() => { setMode(m.id); setError(''); }}
            className={`rounded-full px-3.5 py-1.5 text-xs transition-colors ${
              mode === m.id ? 'bg-neutral-900 font-medium text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
            }`}
          >
            {m.name}
          </button>
        ))}
        <span className="ml-1 hidden text-xs text-neutral-400 lg:inline">{MODES.find((m) => m.id === mode)?.desc}</span>
      </div>

      {/* 核心输入卡片 */}
      <div className="flex flex-col justify-between rounded-[20px] border border-neutral-200 bg-white p-3 shadow-[0_18px_55px_rgba(15,23,42,.10)] sm:rounded-[28px] sm:p-4">
        {/* 输入区（按模式） */}
        {isGenMode ? (
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="描述你的 PPT：主题、受众、风格偏好…（可再展开粘贴源材料）"
            maxLength={2000}
            className="studio-prompt min-h-[64px] w-full resize-none border-0 bg-transparent px-2 pt-1 text-sm leading-6 text-neutral-950 outline-none placeholder:text-neutral-400 focus:outline-none sm:min-h-[72px] sm:text-[15px] sm:leading-7"
          />
        ) : mode === 'edit_native' ? (
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="编辑指令：要改哪些页、怎么改（AI 会自动定位页面）…"
            maxLength={5000}
            className="studio-prompt min-h-[64px] w-full resize-none border-0 bg-transparent px-2 pt-1 text-sm leading-6 text-neutral-950 outline-none placeholder:text-neutral-400 focus:outline-none sm:min-h-[72px]"
          />
        ) : mode === 'beautify' ? (
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="美化要求（可选）：如「深色商务风」「更现代的排版」…"
            maxLength={5000}
            className="studio-prompt min-h-[64px] w-full resize-none border-0 bg-transparent px-2 pt-1 text-sm leading-6 text-neutral-950 outline-none placeholder:text-neutral-400 focus:outline-none sm:min-h-[72px]"
          />
        ) : mode === 'create_template' ? (
          <div className="px-2 pt-1">
          <div className="mb-2 flex gap-1.5">
            {([['deck', '场景方案（多页原型，可翻页预览源稿页面）'], ['style', '风格模板（仅风格规范）']] as const).map(([k, d]) => (
              <button key={k} type="button" title={d}
                onClick={() => setTplKind(k as any)}
                className={`rounded-full px-3 py-1.5 text-xs transition-colors ${tplKind === k ? 'bg-neutral-900 font-medium text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'}`}
              >{k === 'deck' ? '场景方案' : '风格模板'}</button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="模板名称 *（如：科技公司品牌风）"
              className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-orange-400" />
            <input value={tplDesc} onChange={(e) => setTplDesc(e.target.value)} placeholder="适用场景（可选）"
              className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-orange-400" />
          </div>
          </div>
        ) : (
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="补充说明（可选）：截图的主题背景，帮助 AI 更准确重建"
            maxLength={2000}
            className="min-h-[64px] w-full resize-none border-0 bg-transparent px-2 pt-4 text-sm leading-6 text-neutral-950 outline-none placeholder:text-neutral-400 focus:outline-none"
          />
        )}

        {/* 源材料展开（生成模式专属，可折叠） */}
        {isGenMode && (
          <details className="group mx-2 mt-1">
            <summary className="cursor-pointer select-none text-xs text-neutral-400 hover:text-neutral-600">+ 源材料 / 长文本（可选，AI 忠于材料事实）</summary>
            <textarea
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder="粘贴报告 / 文章 / 笔记内容…"
              className="mt-2 h-28 w-full resize-y rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2 text-sm outline-none focus:border-orange-300"
            />
          </details>
        )}



        {/* 底部控制栏 */}
        <div className="mt-2.5 flex flex-col items-stretch justify-between gap-2.5 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-2 sm:flex-nowrap max-sm:overflow-x-auto max-sm:pb-1">
            {/* 上传按钮（语义随模式） */}
            <input ref={fileRef} type="file"
              accept={mode === 'beautify' || mode === 'edit_native' ? '.pptx' : mode === 'create_template' ? '.pptx,image/*' : 'image/*'}
              multiple={!(mode === 'beautify' || mode === 'edit_native')}
              hidden
              onChange={(e) => {
                const kind = mode === 'image_to_pptx' ? 'shots' : isGenMode ? 'image' : 'pptx';
                if (e.target.files) (kind === 'shots' ? shots : kind === 'image' ? assets : srcFile).upload(e.target.files, kind as any);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-neutral-600 transition hover:bg-neutral-100"
              title={
                isGenMode ? `上传图片素材（最多 10 张，AI 参考使用）`
                : mode === 'image_to_pptx' ? '上传页面截图（每张一页）'
                : mode === 'create_template' ? '上传参考 PPTX / 品牌图'
                : '上传 PPTX'
              }
            >
              <Upload size={18} />
            </button>

            {/* 模式专属选择器（行内药丸） */}
            {isGenMode && (
              <>
                <PillSelect value={pages} options={PAGE_OPTS} onChange={setPages} />
                <PillSelect value={format} options={FORMAT_OPTS} onChange={setFormat} />
                <PillSelect value={language} options={LANG_OPTS} onChange={setLanguage} />
                <PillSelect value={imageMode} options={IMAGE_MODE_OPTS} onChange={setImageMode} />
                <PillSelect value={templateId} options={tplOptions} onChange={setTemplateId} wide />
                <button
                  type="button"
                  title={hasTavily ? '规划前先搜索最新资料（用自己的 Key 免费）' : '规划前先搜索最新资料（平台 Key，1 积分/次搜索）'}
                  onClick={() => setResearch(!research)}
                  className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors ${
                    research
                      ? 'border-blue-300 bg-blue-50 font-medium text-blue-700'
                      : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300'
                  }`}
                >
                  <Globe className="h-3.5 w-3.5" />联网研究
                </button>
              </>
            )}
            {!isGenMode && mode !== 'create_template' && (
              <span className="ml-1 text-xs text-neutral-400">
                {mode === 'beautify' && (srcFile.pptx ? `${srcFile.pptx.filename} · 1:1 保内容重排` : '请上传 PPTX →')}
                {mode === 'edit_native' && (srcFile.pptx ? `${srcFile.pptx.filename} · 只改指令命中的页` : '请上传 PPTX →')}
                {mode === 'image_to_pptx' && (shots.items.length ? `${shots.items.length} 张截图 · 按序重建` : '请上传截图 →')}
              </span>
            )}
            {mode === 'create_template' && (
              <span className="ml-1 text-xs text-neutral-400">{srcFile.pptx ? `参考稿：${srcFile.pptx.filename}` : '参考稿可选 · 免费'}</span>
            )}
          </div>

          {/* 积分提示 + 提交 */}
          <div className="flex shrink-0 items-center gap-3">
            <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-0.5 text-[11px] font-medium text-neutral-600">
              {mode === 'create_template' ? '免费' : isGenMode ? (pages === '0' ? 'AI 定页数计费' : `${pages}+ 积分`) : '按页计费'}
            </span>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              title={submitLabel}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-neutral-950 text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              {busy ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={19} />}
            </button>
          </div>
        </div>

        {/* 上传文件缩略区（有内容时显示） */}
        {((isGenMode && assets.items.length > 0) || (mode === 'image_to_pptx' && shots.items.length > 0)) && (
          <div className="mt-2.5 border-t border-neutral-100 pt-2.5">
            <div className="mb-1.5 text-xs text-neutral-400">
              {isGenMode ? `图片素材 ${assets.items.length}/10，AI 会参考使用` : `截图 ${shots.items.length} 张，按上传顺序重建为页面`}
            </div>
            <div className="flex flex-wrap gap-2">
              {(isGenMode ? assets.items : shots.items).map((r, idx) => (
                <div key={r.id} className="group relative h-14 w-14 overflow-hidden rounded-[12px] bg-neutral-100 ring-neutral-900/20 transition hover:ring-2">
                  <img src={r.url} alt={r.filename} className="h-full w-full object-cover" />
                  <span className="pointer-events-none absolute left-1 top-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] leading-none text-white">{idx + 1}</span>
                  <button
                    className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition group-hover:opacity-100"
                    onClick={() => (isGenMode ? assets.setItems((l) => l.filter((x) => x.id !== r.id)) : shots.setItems((l) => l.filter((x) => x.id !== r.id)))}
                  ><X className="h-3 w-3" /></button>
                </div>
              ))}
            </div>
          </div>
        )}
        {!(isGenMode || mode === 'image_to_pptx') && srcFile.pptx && (
          <div className="mt-2.5 flex items-center gap-2 border-t border-neutral-100 pt-2.5">
            <FileUp className="h-4 w-4 text-green-500" />
            <span className="flex-1 truncate text-sm">{srcFile.pptx.filename}</span>
            <button className="text-neutral-400 hover:text-red-500" onClick={() => srcFile.setPptx(null)}><X className="h-4 w-4" /></button>
          </div>
        )}

        {error && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
      </div>

      <p className="mt-3 text-center text-xs text-neutral-400">
        {MODES.find((m) => m.id === mode)?.desc} · 1 积分/页，AI 配图每张 +1，失败自动退还
      </p>

      {/* 模板画廊（仅生成模式）：预览 + 一键选风格 */}
      {isGenMode && builtin.length > 0 && (
        <section className="mt-8">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-neutral-800">模板风格 <span className="ml-1 font-normal text-neutral-400">选择后生成时严格遵循其规范</span></h2>
            <Link to="/templates" className="text-xs text-orange-600 hover:underline">全部模板 →</Link>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {/* 我的模板卡片（带预览） */}
            {myTemplates.map((t) => {
              const selected = templateId === t.id;
              const cover = t.coverSvgUrl;
              return (
                <div key={t.id}
                  className={`group overflow-hidden rounded-xl border bg-white transition-all ${
                    selected ? 'border-orange-400 ring-2 ring-orange-200' : 'border-neutral-200 hover:border-neutral-300 hover:shadow-sm'
                  }`}
                >
                  <div className="relative aspect-video overflow-hidden bg-neutral-50">
                    {cover ? (
                      <img src={cover} alt={t.name} className="absolute inset-0 h-full w-full object-cover" />
                    ) : (
                      <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${(t.style?.palette ?? ['#f5f5f4'])[0]}18, #a8a29e33)` }} />
                    )}
                    <span className="absolute left-2 top-2 rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700">我的</span>
                  </div>
                  <div className="p-2.5">
                    <div className="mb-1 truncate text-sm font-medium">{t.name}</div>
                    <div className="mb-2 line-clamp-1 text-[11px] text-neutral-400" title={t.description}>{t.description || t.style?.mode || ''}</div>
                    <button
                      onClick={() => setTemplateId(selected ? 'auto' : t.id)}
                      className={`w-full rounded-lg py-1.5 text-xs font-medium transition-colors ${
                        selected ? 'bg-orange-600 text-white hover:bg-orange-700' : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-900 hover:text-white'
                      }`}
                    >{selected ? '✓ 已选择该风格' : '选择该风格'}</button>
                  </div>
                </div>
              );
            })}
            {(['deck', 'brand', 'style'] as const).flatMap((k) => builtin.filter((b) => b.kind === k)).map((t) => {
              const selected = templateId === t.id;
              const tag = KIND_TAG[t.kind];
              const cover = t.previewUrl || t.refImages[0]?.url;
              return (
                <div key={t.id}
                  className={`group overflow-hidden rounded-xl border bg-white transition-all ${
                    selected ? 'border-orange-400 ring-2 ring-orange-200' : 'border-neutral-200 hover:border-neutral-300 hover:shadow-sm'
                  }`}
                >
                  {/* 预览区：deck 用页面原型；brand 有 logo 用 logo；否则色板示意 */}
                  <div className="relative aspect-video overflow-hidden bg-neutral-50">
                    {cover ? (
                      cover.endsWith('.svg') ? (
                        <InlineSvg url={cover} className="slide-frame absolute inset-0 [&>svg]:h-full [&>svg]:w-full" />
                      ) : (
                        <img src={cover} alt={t.name} className="absolute inset-0 h-full w-full object-cover" />
                      )
                    ) : (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4"
                        style={{ background: `linear-gradient(135deg, ${t.primaryColor ?? '#f5f5f4'}18, ${t.primaryColor ?? '#a8a29e'}33)` }}>
                        <div className="flex gap-1">
                          {(t.style.palette?.length ? t.style.palette : [t.primaryColor ?? '#d6d3d1']).slice(0, 4).map((c, i) => (
                            <span key={i} className="h-4 w-4 rounded-full border border-white shadow-sm" style={{ background: c }} />
                          ))}
                        </div>
                        <span className="line-clamp-1 text-[11px] font-medium text-neutral-600">{t.style.mode}</span>
                      </div>
                    )}
                    <span className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${tag.cls}`}>{tag.label}</span>
                    {t.pageCount && <span className="absolute right-2 top-2 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">{t.pageCount} 页原型</span>}
                  </div>
                  {/* 信息 + 选择按钮 */}
                  <div className="p-2.5">
                    <div className="mb-1 truncate text-sm font-medium">{t.name}</div>
                    <div className="mb-2 line-clamp-1 text-[11px] text-neutral-400" title={t.summary}>{t.summary}</div>
                    <button
                      onClick={() => setTemplateId(selected ? 'auto' : t.id)}
                      className={`w-full rounded-lg py-1.5 text-xs font-medium transition-colors ${
                        selected ? 'bg-orange-600 text-white hover:bg-orange-700' : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-900 hover:text-white'
                      }`}
                    >
                      {selected ? '✓ 已选择该风格' : '选择该风格'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
