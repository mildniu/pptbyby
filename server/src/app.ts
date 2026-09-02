import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { existsSync, statSync, createReadStream, readdirSync } from 'node:fs';
import { basename, join, isAbsolute } from 'node:path';
import type { Db } from './db.js';
import { verifyPassword, signToken, verifyToken, maskKey } from './crypto.js';
import { getUserGatewayConfig, saveUserGatewayConfig, clearUserGatewayConfig, listGatewayModels } from './gateway.js';
import { createTask, confirmTask, cancelTask, TASK_MODES, type TaskMode } from './orchestrator.js';
import { log, logError } from './logger.js';

export interface AppOptions {
  accessPassword: string;
  secretKey: string;
  dataDir: string;
}

export async function buildApp(opts: AppOptions) {
  const { db } = await (await import('./db.js')).openDb(opts.dataDir);
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
  const SECRET = opts.secretKey;
  const COOKIE = 'pptbyby_session';

  await app.register(cookie);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  // ---------- 鉴权 ----------
  const getAuth = (req: any): { uid: string; role: string } | null => {
    const payload = verifyToken<{ uid: string; role: string; exp: number }>(req.cookies?.[COOKIE], SECRET);
    if (!payload) return null;
    const u = db.prepare('SELECT id, role, status FROM users WHERE id=?').get(payload.uid) as any;
    if (!u || u.status !== 1) return null;
    return { uid: u.id, role: u.role };
  };
  const requireAuth = (req: any, reply: any) => {
    const auth = getAuth(req);
    if (!auth) { reply.code(401).send({ error: '未登录' }); return null; }
    return auth;
  };
  const requireAdmin = (req: any, reply: any) => {
    const auth = requireAuth(req, reply);
    if (!auth) return null;
    if (auth.role !== 'admin') { reply.code(403).send({ error: '需要管理员权限' }); return null; }
    return auth;
  };
  const setSession = (reply: any, uid: string, role: string) => {
    const token = signToken({ uid, role, exp: Date.now() + 30 * 24 * 3600 * 1000 }, SECRET);
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 3600 });
  };

  app.get('/health', async () => ({ ok: true, app: 'pptbyby' }));

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body as any;
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username ?? '')) as any;
    if (!u || !verifyPassword(String(password ?? ''), u.password_hash)) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    if (u.status !== 1) return reply.code(403).send({ error: '账号已禁用' });
    setSession(reply, u.id, u.role);
    return { id: u.id, username: u.username, role: u.role, credits: u.credits };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const { username, password } = req.body as any;
    if (!username || !password || String(password).length < 4) {
      return reply.code(400).send({ error: '用户名和密码必填（密码≥4位）' });
    }
    const exists = db.prepare('SELECT id FROM users WHERE username=?').get(String(username));
    if (exists) return reply.code(409).send({ error: '用户名已存在' });
    const id = `u_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const { hashPassword } = await import('./crypto.js');
    db.prepare('INSERT INTO users(id, username, password_hash, role, credits, created_at) VALUES (?,?,?,?,?,?)').run(
      id, String(username), hashPassword(String(password)), 'user', 20, Date.now()
    );
    setSession(reply, id, 'user');
    return { id, username, role: 'user', credits: 20 };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const u = db.prepare('SELECT id, username, role, credits FROM users WHERE id=?').get(auth.uid) as any;
    return u;
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---------- 网关设置 ----------
  app.get('/api/settings', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const cfg = getUserGatewayConfig(db, auth.uid, SECRET);
    return {
      baseUrl: cfg.baseUrl,
      apiKeyMasked: maskKey(cfg.apiKey),
      hasApiKey: !!cfg.apiKey,
      chatModel: cfg.chatModel,
      imageModel: cfg.imageModel,
      isCustom: cfg.isCustom,
    };
  });

  app.put('/api/settings', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { baseUrl, apiKey, chatModel, imageModel } = req.body as any;
    const cfg = saveUserGatewayConfig(db, auth.uid, SECRET, { baseUrl, apiKey, chatModel, imageModel });
    return { baseUrl: cfg.baseUrl, apiKeyMasked: maskKey(cfg.apiKey), chatModel: cfg.chatModel, imageModel: cfg.imageModel };
  });

  app.delete('/api/settings/custom', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    clearUserGatewayConfig(db, auth.uid);
    return { ok: true };
  });

  app.post('/api/settings/test', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const cfg = getUserGatewayConfig(db, auth.uid, SECRET);
    if (!cfg.baseUrl || !cfg.apiKey) return { ok: false, error: '网关未配置' };
    const models = await listGatewayModels(cfg);
    return { ok: true, models: models.slice(0, 200), chatModel: cfg.chatModel, imageModel: cfg.imageModel };
  });

  app.get('/api/models', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const cfg = getUserGatewayConfig(db, auth.uid, SECRET);
    const models = await listGatewayModels(cfg);
    return { models, chatModel: cfg.chatModel, imageModel: cfg.imageModel };
  });

  // ---------- 任务 ----------
  app.post('/api/tasks', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { mode, topic, sourceText, pages, format, styleHint, audience, language } = req.body as any;
    const m = (TASK_MODES.find((x) => x.id === mode)?.id ?? 'generate') as TaskMode;
    const ready = TASK_MODES.find((x) => x.id === m)?.ready;
    if (!ready) return reply.code(400).send({ error: '该模式即将上线' });
    if (!topic && !sourceText) return reply.code(400).send({ error: '请填写主题或源材料' });
    const p = Math.min(30, Math.max(1, Number(pages) || 8));
    const id = createTask(
      { db, secretKey: SECRET, dataDir: opts.dataDir },
      auth.uid,
      { mode: m, topic: String(topic ?? '').slice(0, 2000), sourceText: String(sourceText ?? '').slice(0, 100000), pages: p, format: format ?? 'ppt169', styleHint, audience, language }
    );
    log('TASK', `用户 [${auth.uid}] 创建任务 ${id} (mode=${m}, pages=${p})`);
    return { id };
  });

  app.get('/api/tasks', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const rows = db
      .prepare('SELECT id, mode, status, topic, created_at, done_at, credits_cost, error FROM tasks WHERE user_id=? ORDER BY created_at DESC LIMIT 100')
      .all(auth.uid) as any[];
    return { tasks: rows };
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const t = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get((req.params as any).id, auth.uid) as any;
    if (!t) return reply.code(404).send({ error: '任务不存在' });
    let spec = null;
    let progress = null;
    try { spec = t.spec_json ? JSON.parse(t.spec_json) : null; } catch { /* ignore */ }
    try { progress = t.progress_json ? JSON.parse(t.progress_json) : null; } catch { /* ignore */ }
    // 生成中的页面 SVG 预览路径
    const slides: { page: number; svg: string }[] = [];
    if (t.result_path || t.status === 'generating' || t.status === 'exporting') {
      // 项目目录名 = taskId 去掉短横线（orchestrator initProject 约定），后缀带 format+日期
      const prefix = String(t.id).replace(/-/g, '_');
      const projectsDir = join(opts.dataDir, 'projects');
      if (existsSync(projectsDir)) {
        const dir = readdirSync(projectsDir).find((d) => d.startsWith(prefix));
        if (dir) {
          const svgDir = join(projectsDir, dir, 'svg_output');
          if (existsSync(svgDir)) {
            const files = readdirSync(svgDir).filter((f) => f.endsWith('.svg')).sort();
            for (const f of files) slides.push({ page: Number(f.match(/\d+/)?.[0] ?? 0), svg: `/media/projects/${dir}/svg_output/${f}` });
          }
        }
      }
    }
    const downloadUrl = (() => {
      if (!t.result_path) return null;
      // result_path = <projectsRoot>/<projDir>/exports/<file>，媒体根为 <projectsRoot>
      const parts = t.result_path.split('/');
      const file = parts.pop();
      const exportsDir = parts.pop();
      const projDir = parts.pop();
      if (!file || exportsDir !== 'exports' || !projDir) return null;
      return `/media/projects/${projDir}/exports/${file}`;
    })();

    return {
      id: t.id, mode: t.mode, status: t.status, topic: t.topic,
      createdAt: t.created_at, doneAt: t.done_at, creditsCost: t.credits_cost, creditsHeld: t.credits_held,
      error: t.error, spec, progress, slides,
      downloadUrl,
    };
  });

  app.post('/api/tasks/:id/confirm', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { spec } = req.body as any;
    const res = confirmTask({ db, secretKey: SECRET, dataDir: opts.dataDir }, (req.params as any).id, auth.uid, spec);
    if (res.error) return reply.code(400).send(res);
    return { ok: true };
  });

  app.post('/api/tasks/:id/cancel', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const res = cancelTask({ db, secretKey: SECRET, dataDir: opts.dataDir }, (req.params as any).id, auth.uid);
    if (res.error) return reply.code(400).send(res);
    return { ok: true };
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const t = db.prepare('SELECT id, status, credits_held FROM tasks WHERE id=? AND user_id=?').get((req.params as any).id, auth.uid) as any;
    if (!t) return reply.code(404).send({ error: '任务不存在' });
    if (['generating', 'exporting', 'planning'].includes(t.status)) {
      return reply.code(400).send({ error: '任务进行中，请先取消' });
    }
    if (t.credits_held) cancelTask({ db, secretKey: SECRET, dataDir: opts.dataDir }, t.id, auth.uid);
    db.prepare('DELETE FROM tasks WHERE id=?').run(t.id);
    return { ok: true };
  });

  // ---------- 管理员 ----------
  app.get('/api/admin/users', async (req, reply) => {
    const auth = requireAdmin(req, reply); if (!auth) return;
    const rows = db.prepare('SELECT id, username, role, status, credits, created_at FROM users ORDER BY created_at').all() as any[];
    return { users: rows };
  });

  app.put('/api/admin/users/:id', async (req, reply) => {
    const auth = requireAdmin(req, reply); if (!auth) return;
    const { credits, status } = req.body as any;
    const id = (req.params as any).id;
    if (credits !== undefined) db.prepare('UPDATE users SET credits=? WHERE id=?').run(Math.max(0, Number(credits) || 0), id);
    if (status !== undefined) db.prepare('UPDATE users SET status=? WHERE id=?').run(status ? 1 : 0, id);
    return { ok: true };
  });

  app.get('/api/admin/tasks', async (req, reply) => {
    const auth = requireAdmin(req, reply); if (!auth) return;
    const rows = db
      .prepare("SELECT t.id, t.user_id, t.mode, t.status, t.topic, t.credits_cost, t.created_at, u.username FROM tasks t LEFT JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 200")
      .all() as any[];
    return { tasks: rows };
  });

  // ---------- 静态媒体（SVG 预览 / 图片 / pptx 下载），路径限定在 data/projects 下 ----------
  app.get('/media/*', async (req, reply) => {
    const auth = getAuth(req);
    if (!auth) return reply.code(401).send({ error: '未登录' });
    // URL 形如 /media/projects/<proj>/...，去掉前导 projects/ 后拼到 projects 根下
    const rel = ((req.params as any)['*'] as string).replace(/^projects\//, '');
    const root = join(opts.dataDir, 'projects');
    const abs = join(root, rel);
    if (!abs.startsWith(root) || !isAbsolute(abs)) return reply.code(403).send({ error: 'forbidden' });
    if (!existsSync(abs) || !statSync(abs).isFile()) return reply.code(404).send({ error: 'not found' });
    const ext = abs.split('.').pop()?.toLowerCase();
    const types: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
    reply.header('Content-Type', types[ext ?? ''] ?? 'application/octet-stream');
    if (ext === 'pptx') reply.header('Content-Disposition', `attachment; filename="${basename(abs)}"`);
    return reply.send(createReadStream(abs));
  });

  return app;
}
