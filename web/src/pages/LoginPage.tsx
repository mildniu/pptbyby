import { useState } from 'react';
import { Presentation } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../stores/app';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const checkAuth = useApp((s) => s.checkAuth);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await api.login(username, password);
      else await api.register(username, password);
      await checkAuth();
    } catch (err: any) {
      setError(err.message ?? '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-orange-50 via-white to-amber-50">
      <form onSubmit={submit} className="w-80 rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Presentation className="h-10 w-10 text-orange-600" />
          <h1 className="text-xl font-bold">PPTByBy</h1>
          <p className="text-xs text-neutral-400">AI 原生可编辑 PPT 生成平台</p>
        </div>
        <div className="mb-4 flex rounded-lg bg-neutral-100 p-1 text-sm">
          <button type="button" className={`flex-1 rounded-md py-1.5 ${mode === 'login' ? 'bg-white shadow-sm font-medium' : 'text-neutral-500'}`} onClick={() => setMode('login')}>登录</button>
          <button type="button" className={`flex-1 rounded-md py-1.5 ${mode === 'register' ? 'bg-white shadow-sm font-medium' : 'text-neutral-500'}`} onClick={() => setMode('register')}>注册</button>
        </div>
        <input
          className="mb-3 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-orange-400"
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="mb-4 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-orange-400"
          placeholder="密码"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
        <button
          className="w-full rounded-lg bg-orange-600 py-2.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
          disabled={busy || !username || !password}
        >
          {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册（送 20 积分）'}
        </button>
      </form>
    </div>
  );
}
