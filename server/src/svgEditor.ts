import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'undici';
import { randomInt } from 'node:crypto';
import { log, logError } from './logger.js';

/**
 * SVG 编辑器进程管理 + 反向代理。
 * pipeline 自带的 svg_editor/server.py（Flask）绑定 127.0.0.1 随机端口，
 * Fastify 把 /editor/:taskId/* 代理过去（剥前缀），鉴权走主站 cookie。
 */

const PY = join(import.meta.dirname, '..', '..', 'pipeline', '.venv', 'bin', 'python');
const SCRIPT = join(import.meta.dirname, '..', '..', 'pipeline', 'scripts', 'svg_editor', 'server.py');

interface EditorSession {
  taskId: string;
  port: number;
  pid: number;
  startedAt: number;
}

/** taskId → session */
const sessions = new Map<string, EditorSession>();

export interface EditorHandle {
  port: number;
  isNew: boolean;
}

/** 为项目启动（或复用）编辑器，返回端口 */
export async function startEditor(projectPath: string, taskId: string): Promise<EditorHandle> {
  // 已有会话：探活
  const existing = sessions.get(taskId);
  if (existing && await isAlive(existing.port)) {
    return { port: existing.port, isNew: false };
  }
  sessions.delete(taskId);

  if (!existsSync(PY)) throw new Error('pipeline/.venv 不存在');
  if (!existsSync(join(projectPath, 'svg_output'))) throw new Error('项目没有 svg_output（任务可能未完成）');

  // 找一个空闲端口（6070-6170）
  const port = await findFreePort(6070, 6170);

  const proc = spawn(PY, [SCRIPT, projectPath, '--no-browser', '--port', String(port), '--timeout', '0'], {
    cwd: projectPath,
    env: { ...process.env, PYTHONUNBUFFERED: '1', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true, // 独立进程组：Fastify 重启不连带杀掉编辑器
  });
  proc.unref();

  // 等 health
  for (let i = 0; i < 40; i++) {
    if (await isAlive(port)) {
      sessions.set(taskId, { taskId, port, pid: proc.pid!, startedAt: Date.now() });
      log('EDITOR', `任务 ${taskId} SVG 编辑器启动 :${port} (pid ${proc.pid})`);
      return { port, isNew: true };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('编辑器启动超时');
}

async function isAlive(port: number): Promise<boolean> {
  try {
    const res = await request(`http://127.0.0.1:${port}/api/health`, { headersTimeout: 2000, bodyTimeout: 2000 });
    return res.statusCode === 200;
  } catch {
    return false;
  }
}

function findFreePort(min: number, max: number): Promise<number> {
  const tryPort = (port: number): Promise<number> =>
    request(`http://127.0.0.1:${port}/api/health`, { headersTimeout: 500, bodyTimeout: 500 })
      .then(() => tryPort(port >= max ? min : port + 1)) // 被占用 → 下一个
      .catch(() => port); // 连不上 = 空闲
  return tryPort(randomInt(min, max));
}

export function stopEditor(taskId: string): boolean {
  const s = sessions.get(taskId);
  if (!s) return false;
  sessions.delete(taskId);
  // HTTP shutdown（优雅停止）
  request(`http://127.0.0.1:${s.port}/api/shutdown`, { method: 'POST', headersTimeout: 3000, bodyTimeout: 3000 }).catch(() => {});
  log('EDITOR', `任务 ${taskId} 编辑器停止 :${s.port}`);
  return true;
}

export function editorStatus(taskId: string): { running: boolean; port?: number } {
  const s = sessions.get(taskId);
  if (!s) return { running: false };
  return { running: true, port: s.port };
}

/** 反向代理 /editor/<taskId>/<path> → flask 127.0.0.1:<port>/<path> */
export async function proxyEditor(
  taskId: string,
  subPath: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const s = sessions.get(taskId);
  if (!s) throw new Error('编辑器未启动');
  const url = `http://127.0.0.1:${s.port}/${subPath}`;
  const h: Record<string, string> = {};
  if (headers['content-type']) h['content-type'] = headers['content-type'];
  if (headers['accept']) h['accept'] = headers['accept'];
  const res = await request(url, {
    method: method as any,
    headers: h,
    body: body && body.length ? body : undefined,
    headersTimeout: 30000,
    bodyTimeout: 120000,
  });
  const buf = Buffer.from(await res.body.arrayBuffer());
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (typeof v === 'string' && !['transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(k)) {
      outHeaders[k] = v;
    }
  }
  return { status: res.statusCode, headers: outHeaders, body: buf };
}
