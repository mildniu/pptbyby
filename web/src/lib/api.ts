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
  tavilyKeyMasked: string;
  hasTavilyKey: boolean;
  isCustom?: boolean;
}

export interface BuiltinTemplate {
  id: string;
  kind: 'brand' | 'style' | 'deck';
  name: string;
  summary: string;
  primaryColor?: string;
  pageCount?: number;
  style: { mode: string; palette: string[]; typography: string; notes: string };
  refImages: { name: string; url: string }[];
  previewUrl: string;
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
  origin: 'ai' | 'user';
  file?: string;
  status: string;
  error?: string;
}

export interface StepProgress {
  key: 'plan' | 'assets' | 'pages' | 'inspect' | 'export';
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt?: number;
  endedAt?: number;
  message?: string;
  detail?: string[];
}

export interface PageProgress {
  id: string;
  title: string;
  role: string;
  status: 'pending' | 'generating' | 'ok' | 'failed';
  error?: string;
  retries?: number;
  attempts?: string[];
}

export interface UploadItem {
  id: string;
  filename: string;
  url: string;
}

export interface TemplateItem {
  id: string;
  name: string;
  description: string;
  style: { mode: string; palette: string[]; typography: string; notes: string };
  coverSvgUrl: string | null;
  created_by: string;
  created_by_name?: string;
  created_at: number;
  updated_at: number;
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
  steps: StepProgress[];
  pages: PageProgress[];
  projectDir?: string;
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
  images: { file: string; url: string }[];
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
  saveSettings: (patch: Partial<{ baseUrl: string; apiKey: string; chatModel: string; imageModel: string; tavilyKey: string }>) =>
    req<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  clearSettings: () => req<{ ok: boolean }>('/api/settings/custom', { method: 'DELETE' }),
  testSettings: () => req<{ ok: boolean; models: string[]; chatModel: string; imageModel: string }>('/api/settings/test', { method: 'POST' }),
  getModels: () => req<{ models: string[]; chatModel: string; imageModel: string }>('/api/models'),

  createTask: (input: Record<string, any>) =>
    req<{ id: string }>('/api/tasks', { method: 'POST', body: JSON.stringify(input) }),
  uploadAssets: async (files: File[]): Promise<UploadItem[]> => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    const res = await fetch('/api/uploads', { method: 'POST', credentials: 'include', body: fd });
    if (res.status === 401) { window.dispatchEvent(new Event('auth:expired')); throw new Error('未登录'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as any).error ?? '上传失败');
    return (data as any).uploads as UploadItem[];
  },
  listTemplates: () => req<{ templates: TemplateItem[] }>('/api/templates'),
  listBuiltinTemplates: () => req<{ templates: BuiltinTemplate[] }>('/api/builtin-templates'),
  createTemplate: (input: { name: string; description?: string; style: any; coverSvg?: string }) =>
    req<{ id: string }>('/api/templates', { method: 'POST', body: JSON.stringify(input) }),
  updateTemplate: (id: string, input: { name?: string; description?: string; style?: any; coverSvg?: string }) =>
    req<{ ok: boolean }>(`/api/templates/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteTemplate: (id: string) => req<{ ok: boolean }>(`/api/templates/${id}`, { method: 'DELETE' }),
  listTasks: () => req<{ tasks: TaskSummary[] }>('/api/tasks'),
  getTask: (id: string) => req<TaskDetail>(`/api/tasks/${id}`),
  confirmTask: (id: string, spec?: DesignSpec) =>
    req<{ ok: boolean }>(`/api/tasks/${id}/confirm`, { method: 'POST', body: JSON.stringify({ spec }) }),
  cancelTask: (id: string) => req<{ ok: boolean }>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  reditTask: (id: string, instruction: string) =>
    req<{ id: string }>(`/api/tasks/${id}/redit`, { method: 'POST', body: JSON.stringify({ instruction }) }),
  editorStart: (id: string) => req<{ ok: boolean; isNew: boolean; url: string }>(`/api/tasks/${id}/editor/start`, { method: 'POST' }),
  editorStop: (id: string) => req<{ ok: boolean }>(`/api/tasks/${id}/editor/stop`, { method: 'POST' }),
  editorStatus: (id: string) => req<{ running: boolean; port?: number }>(`/api/tasks/${id}/editor/status`),
  editorReexport: (id: string) => req<{ ok: boolean; downloadUrl: string }>(`/api/tasks/${id}/editor/reexport`, { method: 'POST' }),
  deleteTask: (id: string) => req<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' }),

  adminUsers: () => req<{ users: (User & { status: number; credits: number; created_at: number })[] }>('/api/admin/users'),
  adminCreateUser: (input: { username: string; password: string; credits?: number; role?: string }) =>
    req<{ id: string }>('/api/admin/users', { method: 'POST', body: JSON.stringify(input) }),
  adminResetPassword: (id: string, password: string) =>
    req<{ ok: boolean }>(`/api/admin/users/${id}/password`, { method: 'PUT', body: JSON.stringify({ password }) }),
  adminUpdateUser: (id: string, patch: { credits?: number; status?: boolean; username?: string; role?: string }) =>
    req<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  adminTasks: () => req<{ tasks: any[] }>('/api/admin/tasks'),
};
