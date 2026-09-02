import { useEffect, useState } from 'react';
import { Loader2, Save, TestTube2, Trash2 } from 'lucide-react';
import { api, type Settings } from '../lib/api';

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [chatModel, setChatModel] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const s = await api.getSettings();
    setSettings(s);
    setBaseUrl(s.baseUrl);
    setChatModel(s.chatModel);
    setImageModel(s.imageModel);
  };
  useEffect(() => { load().catch(() => setSettings({ baseUrl: '', apiKeyMasked: '', hasApiKey: false, chatModel: '', imageModel: '' })); }, []);

  const save = async () => {
    setBusy(true); setMsg('');
    try {
      await api.saveSettings({ baseUrl, apiKey: apiKey || undefined, chatModel, imageModel });
      setMsg('已保存');
      setApiKey('');
      await load();
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await api.testSettings();
      if (r.ok) {
        setModels(r.models);
        setMsg(`连接成功，${r.models.length} 个模型可用`);
      } else setMsg("连接失败");
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };

  if (!settings) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-neutral-300" /></div>;

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="mb-1 text-2xl font-bold">网关设置</h1>
      <p className="mb-6 text-sm text-neutral-500">
        配置 OpenAI 兼容网关。{settings.isCustom ? '当前使用你的专属接口（生 PPT 免积分继承限制，仍按页计费）。' : '未配置时继承平台共享接口。'}
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
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Chat 模型（驱动大纲与逐页生成）</label>
            {models.length > 0 ? (
              <select className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                value={chatModel} onChange={(e) => setChatModel(e.target.value)}>
                <option value="">（选择模型）</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                placeholder="例如 claude-opus-4 / glm-4.7 / kimi-k3…" value={chatModel} onChange={(e) => setChatModel(e.target.value)} />
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">生图模型（PPT 配图）</label>
            {models.length > 0 ? (
              <select className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                value={imageModel} onChange={(e) => setImageModel(e.target.value)}>
                <option value="">（选择模型）</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input className="w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-orange-400"
                placeholder="例如 gpt-image-2 / qwen-image…" value={imageModel} onChange={(e) => setImageModel(e.target.value)} />
            )}
          </div>
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
