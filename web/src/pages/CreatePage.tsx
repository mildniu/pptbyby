import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, ListChecks, Wand2, Paintbrush, FileEdit, LayoutTemplate, ImagePlay, Coins, UploadCloud, X, Loader2 } from 'lucide-react';
import { api, type TemplateItem, type UploadItem } from '../lib/api';

const MODES = [
  { id: 'generate', name: '生成 PPT', icon: ListChecks, desc: '主题/文档 → 确认大纲 → 逐页生成', ready: true },
  { id: 'quick', name: '快速生成', icon: Zap, desc: '跳过确认，一步直出', ready: true },
  { id: 'beautify', name: '美化 PPT', icon: Paintbrush, desc: '保持内容重排视觉', ready: false },
  { id: 'edit_native', name: '编辑 PPT', icon: FileEdit, desc: '保留原设计改内容', ready: false },
  { id: 'create_template', name: '创建模板', icon: LayoutTemplate, desc: '蒸馏品牌/版式模板', ready: false },
  { id: 'image_to_pptx', name: '图片转 PPT', icon: ImagePlay, desc: '页面截图重建可编辑', ready: false },
];

const FORMATS = [
  { id: 'ppt169', name: '16:9 宽屏' },
  { id: 'ppt43', name: '4:3 传统' },
];

export default function CreatePage() {
  const nav = useNavigate();
  const [mode, setMode] = useState('generate');
  const [topic, setTopic] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [pages, setPages] = useState<number>(8); // 0 = AI 决定
  const [format, setFormat] = useState('ppt169');
  const [styleHint, setStyleHint] = useState('');
  const [language, setLanguage] = useState('中文');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [assets, setAssets] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.listTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
  }, []);

  const uploadFiles = async (files: FileList | File[]) => {
    const imgs = [...files].filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    setUploading(true);
    try {
      const uploaded = await api.uploadAssets(imgs);
      setAssets((a) => [...a, ...uploaded].slice(0, 10));
    } catch (e: any) { setError(e.message); } finally { setUploading(false); }
  };

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const { id } = await api.createTask({
        mode, topic, sourceText, pages, format, styleHint, language,
        templateId: templateId || null,
        assetIds: assets.map((a) => a.id),
      });
      nav(`/task/${id}`);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  const est = pages === 0 ? 'AI 决定' : `${pages}+`; // 每页 1 积分（AI 配图每张 +1）

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="mb-1 text-2xl font-bold">创建 PPT</h1>
      <p className="mb-5 text-sm text-neutral-500">AI 逐页手写矢量页面，导出为 PowerPoint 原生可编辑对象</p>

      {/* 模式选择：紧凑小卡片 */}
      <div className="mb-5 grid grid-cols-6 gap-2">
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              onClick={() => m.ready && setMode(m.id)}
              disabled={!m.ready}
              title={m.ready ? m.desc : '即将上线'}
              className={`group flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 transition-all ${
                active
                  ? 'border-orange-400 bg-orange-50 shadow-sm ring-1 ring-orange-200'
                  : 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50'
              } ${!m.ready ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
            >
              <Icon className={`h-5 w-5 ${active ? 'text-orange-600' : 'text-neutral-400 group-hover:text-neutral-500'}`} />
              <span className={`text-xs ${active ? 'font-semibold text-orange-700' : 'text-neutral-600'}`}>{m.name}</span>
            </button>
          );
        })}
      </div>
      <p className="mb-5 -mt-2 text-xs text-neutral-400">{MODES.find((m) => m.id === mode)?.desc}</p>

      <div className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-6">
        <div>
          <label className="mb-1.5 block text-sm font-medium">主题</label>
          <input
            className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
            placeholder="例如：2026 年 Q3 业绩回顾、区块链入门、产品发布会…"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">源材料 <span className="font-normal text-neutral-400">（可选，粘贴文本，AI 忠于材料事实）</span></label>
          <textarea
            className="h-28 w-full resize-y rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
            placeholder="粘贴报告/文章/笔记内容…"
            value={sourceText}
            onChange={(e) => setSourceText(e.target.value)}
          />
        </div>

        {/* 素材上传 */}
        <div>
          <label className="mb-1.5 block text-sm font-medium">图片素材 <span className="font-normal text-neutral-400">（可选，最多 10 张，AI 会参考使用）</span></label>
          <div
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-4 py-3 text-sm text-neutral-500 hover:border-orange-300 hover:bg-orange-50/40"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); uploadFiles(e.dataTransfer.files); }}
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin text-orange-500" /> : <UploadCloud className="h-4 w-4 text-neutral-400" />}
            {uploading ? '上传中…' : '点击或拖拽图片到这里（png / jpg / webp，单张 ≤ 20MB）'}
          </div>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && uploadFiles(e.target.files)} />
          {assets.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {assets.map((a) => (
                <div key={a.id} className="group relative h-16 w-24 overflow-hidden rounded-md border border-neutral-200">
                  <img src={a.url} alt={a.filename} className="h-full w-full object-cover" />
                  <button
                    className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => setAssets((list) => list.filter((x) => x.id !== a.id))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-4 gap-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">页数</label>
            <select
              className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-400"
              value={pages}
              onChange={(e) => setPages(Number(e.target.value))}
            >
              <option value={0}>✨ AI 决定</option>
              {[5, 6, 8, 10, 12, 15, 20, 30].map((n) => <option key={n} value={n}>{n} 页</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">画幅</label>
            <select
              className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-400"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
            >
              {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">语言</label>
            <select
              className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-400"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="中文">中文</option>
              <option value="English">English</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">模板 <span className="font-normal text-neutral-400">（可选）</span></label>
            <select
              className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-400"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">自由设计</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">风格偏好 <span className="font-normal text-neutral-400">（可选，选择模板后由模板主导）</span></label>
          <input
            className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
            placeholder="例如：商务深色数据风 / 杂志编辑风 / 瑞士网格…"
            value={styleHint}
            onChange={(e) => setStyleHint(e.target.value)}
          />
        </div>

        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}

        <div className="flex items-center justify-between border-t border-neutral-100 pt-4">
          <div className="flex items-center gap-1.5 text-sm text-neutral-500">
            <Coins className="h-4 w-4 text-amber-500" />
            预计 <span className="font-medium text-neutral-700">{est} 积分</span>
            <span className="text-xs text-neutral-400">（1 积分/页，AI 配图每张 +1，完成后多退少补）</span>
          </div>
          <button
            className="flex items-center gap-2 rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
            disabled={busy || uploading || (!topic && !sourceText)}
            onClick={submit}
          >
            <Wand2 className="h-4 w-4" />
            {busy ? '创建中…' : mode === 'quick' ? '立即生成' : '生成大纲'}
          </button>
        </div>
      </div>
    </div>
  );
}
