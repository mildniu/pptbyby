import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Presentation } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../stores/app';

export default function LoginPage() {
  const [mode] = useState<'login'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const checkAuth = useApp((s) => s.checkAuth);
  const authed = useApp((s) => s.authed);
  const nav = useNavigate();

  // 已登录（含刚登录成功）跳转到创建页
  useEffect(() => {
    if (authed) nav('/create', { replace: true });
  }, [authed, nav]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.login(username, password);
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
          {busy ? '请稍候…' : '登录'}
        </button>
      </form>
    </div>
  );
}
