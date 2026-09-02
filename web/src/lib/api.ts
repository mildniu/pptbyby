export interface User {
  id: string;
  username: string;
  role: 'admin' | 'user';
  credits?: number;
}

export interface Settings {
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  chatModel: string;
  imageModel: string;
  isCustom?: boolean;
}

export interface PageSpec {
  id: string;
  role: string;
  title: string;
  outline: string;
}

export interface ImageSpec {
  id: string;
  desc: string;
  usage: string;
  status: string;
  file?: string;
}

export interface DesignSpec {
  title: string;
  format: string;
  pages: PageSpec[];
  images: ImageSpec[];
  style: { mode: string; palette: string[]; typography: string; notes: string };
}

export interface TaskProgress {
  phase: string;
  currentPage: number;
  totalPages: number;
  pages?: { id: string; title: string; status: string; error?: string; retries?: number }[];
  message?: string;
}

export interface TaskDetail {
  id: string;
  mode: string;
  status: string;
  topic: string;
  createdAt: number;
  doneAt: number | null;
  creditsCost: number;
  creditsHeld: number;
  error: string | null;
  spec: DesignSpec | null;
  progress: TaskProgress | null;
  slides: { page: number; svg: string }[];
  downloadUrl: string | null;
}

export interface TaskSummary {
  id: string;
  mode: string;
  status: string;
  topic: string;
  created_at: number;
  done_at: number | null;
  credits_cost: number;
  error: string | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (res.status === 401) {
    window.dispatchEvent(new Event('auth:expired'));
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error ?? `请求失败 (${res.status})`);
  return data as T;
}

export const api = {
  login: (username: string, password: string) =>
    req<User>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  register: (username: string, password: string) =>
    req<User>('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => req<User>('/api/auth/me'),

  getSettings: () => req<Settings>('/api/settings'),
  saveSettings: (patch: Partial<{ baseUrl: string; apiKey: string; chatModel: string; imageModel: string }>) =>
    req<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  clearSettings: () => req<{ ok: boolean }>('/api/settings/custom', { method: 'DELETE' }),
  testSettings: () => req<{ ok: boolean; models: string[]; chatModel: string; imageModel: string }>('/api/settings/test', { method: 'POST' }),
  getModels: () => req<{ models: string[]; chatModel: string; imageModel: string }>('/api/models'),

  createTask: (input: { mode: string; topic?: string; sourceText?: string; pages?: number; format?: string; styleHint?: string; audience?: string; language?: string }) =>
    req<{ id: string }>('/api/tasks', { method: 'POST', body: JSON.stringify(input) }),
  listTasks: () => req<{ tasks: TaskSummary[] }>('/api/tasks'),
  getTask: (id: string) => req<TaskDetail>(`/api/tasks/${id}`),
  confirmTask: (id: string, spec?: DesignSpec) =>
    req<{ ok: boolean }>(`/api/tasks/${id}/confirm`, { method: 'POST', body: JSON.stringify({ spec }) }),
  cancelTask: (id: string) => req<{ ok: boolean }>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  deleteTask: (id: string) => req<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' }),

  adminUsers: () => req<{ users: (User & { status: number; credits: number; created_at: number })[] }>('/api/admin/users'),
  adminUpdateUser: (id: string, patch: { credits?: number; status?: boolean }) =>
    req<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  adminTasks: () => req<{ tasks: any[] }>('/api/admin/tasks'),
};
