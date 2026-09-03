import { useEffect, useState } from 'react';
import { Loader2, Save, TestTube2, Trash2, Globe } from 'lucide-react';
import { api, type Settings } from '../lib/api';

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [chatModel, setChatModel] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [tavilyKey, setTavilyKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [tavilyOk, setTavilyOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const s = await api.getSettings();
    setSettings(s);
    setBaseUrl(s.baseUrl);
    setChatModel(s.chatModel);
    setImageModel(s.imageModel);
  };
  useEffect(() => { load().catch(() => setSettings({ baseUrl: '', apiKeyMasked: '', hasApiKey: false, chatModel: '', imageModel: '', tavilyKeyMasked: '', hasTavilyKey: false })); }, []);

  const save = async () => {
    setBusy(true); setMsg('');
    try {
      await api.saveSettings({ baseUrl, apiKey: apiKey || undefined, chatModel, imageModel, tavilyKey: tavilyKey || undefined });
      setMsg('已保存');
      setApiKey('');
      setTavilyKey('');
      setTavilyOk(null);
      await load();
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setMsg(''); setTavilyOk(null);
    try {
      const r = await api.testSettings();
      if (r.ok) {
        setModels((r as any).models ?? []);
        setTavilyOk((r as any).tavilyOk ?? null);
        const parts = [`连接成功，${((r as any).models ?? []).length} 个模型可用`];
        if ((r as any).tavilyOk === true) parts.push('Tavily 搜索可用 ✓');
        if ((r as any).tavilyOk === false) parts.push('Tavily Key 无效 ✗');
        setMsg(parts.join('；'));
      } else setMsg((r as any).error ?? '连接失败');
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };

  if (!settings) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-neutral-300" /></div>;

  const ModelSelect = ({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder: string }) =>
    models.length > 0 ? (
      <select className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-400"
        value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">（选择模型）</option>
        {models.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    ) : (
      <input className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
        placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    );

  return (
    <div className="mx-auto max-w-2xl px-3 py-5 sm:px-6 sm:py-8">
      <h1 className="mb-1 text-2xl font-bold">网关设置</h1>
      <p className="mb-6 text-sm text-neutral-500">
        配置 OpenAI 兼容网关。{settings.isCustom ? '当前使用你的专属接口。' : '未配置时继承平台共享接口。'}
      </p>

      <div className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-6">
        <div>
          <label className="mb-1.5 block text-sm font-medium">Base URL</label>
          <input className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
            placeholder="https://your-gateway.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium">API Key</label>
          <input className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
            placeholder={settings.hasApiKey ? `已保存（${settings.apiKeyMasked}），留空则不修改` : 'sk-…'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Chat 模型 <span className="font-normal text-neutral-400">（驱动大纲与逐页生成）</span></label>
            <ModelSelect value={chatModel} onChange={setChatModel} label="chat" placeholder="例如 claude-opus-4 / glm-4.7 / kimi-k3…" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">生图模型 <span className="font-normal text-neutral-400">（PPT 配图，由大纲自动决定张数）</span></label>
            <ModelSelect value={imageModel} onChange={setImageModel} label="image" placeholder="例如 gpt-image-2 / qwen-image…" />
          </div>
        </div>

        {/* Tavily */}
        <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-4">
          <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium"><Globe className="h-4 w-4 text-blue-500" />Tavily 搜索 <span className="font-normal text-neutral-400">（可选，联网研究补充资料；支持多个 Key，逗号或换行分隔，自动轮换）</span></label>
          <textarea className="h-20 w-full resize-y rounded-lg border border-neutral-200 bg-white px-3 py-2.5 font-mono text-sm outline-none focus:border-blue-400"
            placeholder={settings.hasTavilyKey ? `已保存（${settings.tavilyKeyMasked}），留空则不修改；重新填写将整体替换` : 'tvly-…\ntvly-…（app.tavily.com 免费注册，可填多个）'} value={tavilyKey} onChange={(e) => setTavilyKey(e.target.value)} />
          <p className="mt-1.5 text-xs text-neutral-400">
            配置后创建任务可用「联网研究」（规划前搜索最新资料）。
            {settings.tavilyKeyOwn
              ? <span className="text-emerald-600">用自己的 Key 搜索，不消耗积分。</span>
              : '用自己的 Key 搜索免费；未配置时使用平台 Key（1 积分/次搜索）。'}
            {tavilyOk === true && <span className="ml-1 text-green-600">当前 Key 有效 ✓</span>}
            {tavilyOk === false && <span className="ml-1 text-red-500">当前 Key 无效 ✗</span>}
          </p>
        </div>

        {msg && <div className="rounded-lg bg-neutral-100 px-3 py-2 text-xs text-neutral-600">{msg}</div>}

        <div className="flex items-center gap-2">
          <button onClick={save} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50">
            <Save className="h-4 w-4" />保存
          </button>
          <button onClick={test} disabled={busy} className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-50 disabled:opacity-50">
            <TestTube2 className="h-4 w-4" />测试并列出模型
          </button>
          {settings.isCustom && (
            <button onClick={async () => { await api.clearSettings(); await load(); setModels([]); }} className="ml-auto flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2 text-xs text-neutral-500 hover:bg-red-50 hover:text-red-500">
              <Trash2 className="h-3.5 w-3.5" />清除专属配置
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
