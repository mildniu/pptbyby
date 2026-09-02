import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, ListChecks, Wand2, Paintbrush, FileEdit, LayoutTemplate, ImagePlay, Coins } from 'lucide-react';
import { api } from '../lib/api';

const MODES = [
  { id: 'generate', name: '生成 PPT', icon: ListChecks, desc: '主题/材料 → 确认大纲 → 逐页生成', ready: true },
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
  const [pages, setPages] = useState(8);
  const [format, setFormat] = useState('ppt169');
  const [styleHint, setStyleHint] = useState('');
  const [language, setLanguage] = useState('中文');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const { id } = await api.createTask({ mode, topic, sourceText, pages, format, styleHint, language });
      nav(`/task/${id}`);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  const est = pages; // 每页 1 积分（另有生图每张 +1，上限由大纲决定）

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="mb-1 text-2xl font-bold">创建 PPT</h1>
      <p className="mb-6 text-sm text-neutral-500">AI 逐页手写矢量页面，导出为 PowerPoint 原生可编辑对象</p>

      {/* 模式选择 */}
      <div className="mb-6 grid grid-cols-3 gap-3">
        {MODES.map((m) => {
          const Icon = m.icon;
          return (
            <button
              key={m.id}
              onClick={() => m.ready && setMode(m.id)}
              disabled={!m.ready}
              className={`rounded-xl border p-3 text-left transition-colors ${
                mode === m.id ? 'border-orange-400 bg-orange-50' : 'border-neutral-200 bg-white hover:border-neutral-300'
              } ${!m.ready ? 'cursor-not-allowed opacity-45' : ''}`}
            >
              <Icon className={`mb-1.5 h-5 w-5 ${mode === m.id ? 'text-orange-600' : 'text-neutral-400'}`} />
              <div className="text-sm font-medium">{m.name}</div>
              <div className="mt-0.5 text-[11px] leading-tight text-neutral-400">{m.ready ? m.desc : '即将上线'}</div>
            </button>
          );
        })}
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-6">
        <label className="mb-1.5 block text-sm font-medium">主题</label>
        <input
          className="mb-4 w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
          placeholder="例如：2026 年 Q3 业绩回顾、区块链入门、产品发布会…"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />

        <label className="mb-1.5 block text-sm font-medium">源材料 <span className="font-normal text-neutral-400">（可选，粘贴文本，AI 忠于材料事实）</span></label>
        <textarea
          className="mb-4 h-32 w-full resize-y rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
          placeholder="粘贴报告/文章/笔记内容…"
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
        />

        <div className="mb-4 grid grid-cols-3 gap-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">页数</label>
            <input
              type="number" min={1} max={30}
              className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
              value={pages}
              onChange={(e) => setPages(Math.min(30, Math.max(1, Number(e.target.value) || 8)))}
            />
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
        </div>

        <label className="mb-1.5 block text-sm font-medium">风格偏好 <span className="font-normal text-neutral-400">（可选）</span></label>
        <input
          className="mb-5 w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
          placeholder="例如：商务深色数据风 / 杂志编辑风 / 瑞士网格…"
          value={styleHint}
          onChange={(e) => setStyleHint(e.target.value)}
        />

        {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-sm text-neutral-500">
            <Coins className="h-4 w-4 text-amber-500" />
            预计 <span className="font-medium text-neutral-700">{est}+ 积分</span>
            <span className="text-xs text-neutral-400">（1 积分/页，AI 配图每张 +1，完成后多退少补）</span>
          </div>
          <button
            className="flex items-center gap-2 rounded-lg bg-orange-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
            disabled={busy || (!topic && !sourceText)}
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
