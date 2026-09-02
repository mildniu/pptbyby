import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { existsSync, statSync, createReadStream, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
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

  // 启动恢复：进程重启会丢掉内存中的异步编排 promise，
  // 把中断的进行中任务标失败并退还预扣积分（awaiting_confirm 无在途工作，保留）
  {
    const orphans = db
      .prepare("SELECT id, user_id, credits_held FROM tasks WHERE status IN ('planning','generating','exporting')")
      .all() as any[];
    for (const t of orphans) {
      db.prepare('UPDATE tasks SET status=?, error=?, done_at=? WHERE id=?').run(
        'failed', '服务重启，任务中断（预扣积分已退还）', Date.now(), t.id
      );
      if (t.credits_held > 0) {
        db.prepare('UPDATE users SET credits = credits + ? WHERE id=?').run(t.credits_held, t.user_id);
        db.prepare('INSERT INTO credit_logs(user_id, delta, reason, task_id, created_at) VALUES (?,?,?,?,?)').run(
          t.user_id, t.credits_held, '服务重启退还', t.id, Date.now()
        );
        db.prepare('UPDATE tasks SET credits_held=0 WHERE id=?').run(t.id);
      }
      logError('BOOT', `任务 ${t.id} 因服务重启标记失败并退款 ${t.credits_held}`);
    }
  }
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
    const { mode, topic, sourceText, pages, format, styleHint, audience, language, templateId, assetIds } = req.body as any;
    const m = (TASK_MODES.find((x) => x.id === mode)?.id ?? 'generate') as TaskMode;
    const ready = TASK_MODES.find((x) => x.id === m)?.ready;
    if (!ready) return reply.code(400).send({ error: '该模式即将上线' });
    if (!topic && !sourceText) return reply.code(400).send({ error: '请填写主题或源材料' });
    const p = Math.min(30, Math.max(0, Number(pages) || 0)); // 0 = AI 决定
    const id = createTask(
      { db, secretKey: SECRET, dataDir: opts.dataDir },
      auth.uid,
      {
        mode: m, topic: String(topic ?? '').slice(0, 2000), sourceText: String(sourceText ?? '').slice(0, 100000),
        pages: p, format: format ?? 'ppt169', styleHint, audience, language,
        templateId: templateId || null,
        assetIds: Array.isArray(assetIds) ? assetIds.map(String).slice(0, 10) : [],
      }
    );
    log('TASK', `用户 [${auth.uid}] 创建任务 ${id} (mode=${m}, pages=${p || 'AI'}, assets=${assetIds?.length ?? 0}, tpl=${templateId ?? '-'})`);
    return { id };
  });

  // ---------- 素材上传 ----------
  app.post('/api/uploads', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const files = req.files();
    const uploadDir = join(opts.dataDir, 'uploads');
    mkdirSync(uploadDir, { recursive: true });
    const results: { id: string; filename: string; url: string }[] = [];
    for await (const file of files) {
      if (!file.mimetype?.startsWith('image/')) {
        return reply.code(400).send({ error: `仅支持图片文件，收到 ${file.mimetype}` });
      }
      const buf = await file.toBuffer();
      if (buf.length > 20 * 1024 * 1024) return reply.code(400).send({ error: `${file.filename} 超过 20MB 上限` });
      const id = randomUUID();
      const ext = file.filename.match(/\.(png|jpe?g|webp|gif)$/i)?.[0]?.toLowerCase() ?? '.png';
      const safe = `${id}${ext}`;
      writeFileSync(join(uploadDir, safe), buf);
      db.prepare('INSERT INTO uploads(id, user_id, filename, path, mime, size, created_at) VALUES (?,?,?,?,?,?,?)').run(
        id, auth.uid, file.filename, join(uploadDir, safe), file.mimetype, buf.length, Date.now()
      );
      results.push({ id, filename: file.filename, url: `/media/uploads/${safe}` });
    }
    if (!results.length) return reply.code(400).send({ error: '没有收到文件' });
    return { uploads: results };
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
    // 项目目录定位（progress.projectDir 优先，回退按 taskId 前缀扫描）
    const projectsDir = join(opts.dataDir, 'projects');
    const prefix = String(t.id).replace(/-/g, '_');
    let projDir: string | null = (progress as any)?.projectDir ?? null;
    if (!projDir && existsSync(projectsDir)) {
      projDir = readdirSync(projectsDir).find((d) => d.startsWith(prefix)) ?? null;
    }
    // 页面 SVG 预览 + 项目图片素材
    const slides: { page: number; svg: string }[] = [];
    const images: { file: string; url: string }[] = [];
    if (projDir && (t.result_path || t.status === 'generating' || t.status === 'exporting' || t.status === 'done')) {
      const svgDir = join(projectsDir, projDir, 'svg_output');
      if (existsSync(svgDir)) {
        const files = readdirSync(svgDir).filter((f) => f.endsWith('.svg')).sort();
        for (const f of files) slides.push({ page: Number(f.match(/\d+/)?.[0] ?? 0), svg: `/media/projects/${projDir}/svg_output/${f}` });
      }
      const imgDir = join(projectsDir, projDir, 'images');
      if (existsSync(imgDir)) {
        for (const f of readdirSync(imgDir).sort()) {
          if (/\.(png|jpe?g|webp|gif)$/i.test(f)) images.push({ file: f, url: `/media/projects/${projDir}/images/${f}` });
        }
      }
    }
    const downloadUrl = (() => {
      if (!t.result_path) return null;
      // result_path = <projectsRoot>/<projDir>/exports/<file>，媒体根为 <projectsRoot>
      const parts = t.result_path.split('/');
      const file = parts.pop();
      const exportsDir = parts.pop();
      const projDir2 = parts.pop();
      if (!file || exportsDir !== 'exports' || !projDir2) return null;
      return `/media/projects/${projDir2}/exports/${file}`;
    })();

    return {
      id: t.id, mode: t.mode, status: t.status, topic: t.topic,
      createdAt: t.created_at, doneAt: t.done_at, creditsCost: t.credits_cost, creditsHeld: t.credits_held,
      error: t.error, spec, progress, slides, images,
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

  // ---------- 模板 ----------
  app.get('/api/templates', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const rows = db
      .prepare(`SELECT t.id, t.name, t.description, t.style_json, t.cover_svg, t.created_by, t.created_at, t.updated_at, u.username AS created_by_name
                FROM templates t LEFT JOIN users u ON u.id = t.created_by
                WHERE t.created_by=? OR t.created_by='admin' ORDER BY t.updated_at DESC`)
      .all(auth.uid) as any[];
    return {
      templates: rows.map((r) => ({
        ...r,
        style: (() => { try { return JSON.parse(r.style_json); } catch { return {}; } })(),
        style_json: undefined,
        coverSvgUrl: r.cover_svg ? `/api/templates/${r.id}/cover` : null,
      })),
    };
  });

  app.post('/api/templates', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const { name, description, style, coverSvg } = req.body as any;
    if (!name || !String(name).trim()) return reply.code(400).send({ error: '模板名称必填' });
    const id = randomUUID();
    const styleJson = JSON.stringify({
      mode: String(style?.mode ?? '').slice(0, 100),
      palette: Array.isArray(style?.palette) ? style.palette.slice(0, 8).map((c: any) => String(c).slice(0, 9)) : [],
      typography: String(style?.typography ?? '').slice(0, 500),
      notes: String(style?.notes ?? '').slice(0, 1000),
    });
    const cover = typeof coverSvg === 'string' && coverSvg.includes('<svg') ? coverSvg.slice(0, 200000) : null;
    db.prepare('INSERT INTO templates(id, name, description, style_json, cover_svg, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(
      id, String(name).slice(0, 100), String(description ?? '').slice(0, 500), styleJson, cover, auth.uid, Date.now(), Date.now()
    );
    log('TPL', `用户 [${auth.uid}] 创建模板 ${id} (${name})`);
    return { id };
  });

  app.put('/api/templates/:id', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const t = db.prepare('SELECT * FROM templates WHERE id=?').get((req.params as any).id) as any;
    if (!t) return reply.code(404).send({ error: '模板不存在' });
    if (t.created_by !== auth.uid && auth.role !== 'admin') return reply.code(403).send({ error: '只能编辑自己的模板' });
    const { name, description, style, coverSvg } = req.body as any;
    const styleJson = style
      ? JSON.stringify({
          mode: String(style.mode ?? '').slice(0, 100),
          palette: Array.isArray(style.palette) ? style.palette.slice(0, 8).map((c: any) => String(c).slice(0, 9)) : [],
          typography: String(style.typography ?? '').slice(0, 500),
          notes: String(style.notes ?? '').slice(0, 1000),
        })
      : t.style_json;
    const cover = typeof coverSvg === 'string' ? (coverSvg.includes('<svg') ? coverSvg.slice(0, 200000) : null) : t.cover_svg;
    db.prepare('UPDATE templates SET name=?, description=?, style_json=?, cover_svg=?, updated_at=? WHERE id=?').run(
      String(name ?? t.name).slice(0, 100), String(description ?? t.description).slice(0, 500), styleJson, cover, Date.now(), t.id
    );
    return { ok: true };
  });

  app.delete('/api/templates/:id', async (req, reply) => {
    const auth = requireAuth(req, reply); if (!auth) return;
    const t = db.prepare('SELECT * FROM templates WHERE id=?').get((req.params as any).id) as any;
    if (!t) return reply.code(404).send({ error: '模板不存在' });
    if (t.created_by !== auth.uid && auth.role !== 'admin') return reply.code(403).send({ error: '只能删除自己的模板' });
    db.prepare('DELETE FROM templates WHERE id=?').run(t.id);
    return { ok: true };
  });

  app.get('/api/templates/:id/cover', async (req, reply) => {
    const t = db.prepare('SELECT cover_svg FROM templates WHERE id=?').get((req.params as any).id) as any;
    if (!t?.cover_svg) return reply.code(404).send({ error: 'no cover' });
    reply.header('Content-Type', 'image/svg+xml');
    return reply.send(t.cover_svg);
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

  // ---------- 静态媒体（SVG 预览 / 图片 / pptx 下载 / 上传素材），路径限定在 data 下 ----------
  app.get('/media/*', async (req, reply) => {
    const auth = getAuth(req);
    if (!auth) return reply.code(401).send({ error: '未登录' });
    const raw = (req.params as any)['*'] as string;
    // /media/uploads/<file> → dataDir/uploads；/media/projects/<proj>/... → dataDir/projects
    let root: string;
    let rel: string;
    if (raw.startsWith('uploads/')) {
      root = join(opts.dataDir, 'uploads');
      rel = raw.slice('uploads/'.length);
    } else if (raw.startsWith('projects/')) {
      root = join(opts.dataDir, 'projects');
      rel = raw.slice('projects/'.length);
    } else {
      return reply.code(403).send({ error: 'forbidden' });
    }
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
