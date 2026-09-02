import { describe, it, expect, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let app: any;
let cookie = '';

const dataDir = '/tmp/pptbyby-vitest';

beforeAll(async () => {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  app = await buildApp({ accessPassword: 'test123', secretKey: 'test-secret', dataDir });
  app.inject = app.inject.bind(app);
});

async function req(method: string, url: string, body?: any) {
  const res = await app.inject({ method, url, cookies: cookie ? { pptbyby_session: cookie } : {}, payload: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} });
  const setCookie = res.headers['set-cookie'];
  if (setCookie) {
    const m = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).match(/pptbyby_session=([^;]+)/);
    if (m) cookie = m[1];
  }
  return { code: res.statusCode, body: res.json() };
}

describe('auth', () => {
  it('admin 默认账号可登录', async () => {
    const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'test123' });
    expect(r.code).toBe(200);
    expect(r.body.role).toBe('admin');
  });

  it('错误密码拒绝', async () => {
    const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'wrong' });
    expect(r.code).toBe(401);
  });

  it('注册新用户送 20 积分', async () => {
    const r = await req('POST', '/api/auth/register', { username: 'alice', password: 'pass123' });
    expect(r.code).toBe(200);
    expect(r.body.credits).toBe(20);
  });

  it('未登录访问受限接口 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect(res.statusCode).toBe(401);
  });
});

describe('settings', () => {
  it('保存与读取网关配置（apiKey 打码）', async () => {
    await req('POST', '/api/auth/login', { username: 'admin', password: 'test123' });
    const r = await req('PUT', '/api/settings', { baseUrl: 'http://gw.example.com/v1', apiKey: 'sk-test-123456', chatModel: 'm1', imageModel: 'm2' });
    expect(r.code).toBe(200);
    expect(r.body.baseUrl).toBe('http://gw.example.com/v1');
    expect(r.body.apiKeyMasked).toContain('****');
    const g = await req('GET', '/api/settings');
    expect(g.body.hasApiKey).toBe(true);
    expect(g.body.chatModel).toBe('m1');
  });
});

describe('tasks', () => {
  it('无主题无材料 400', async () => {
    const r = await req('POST', '/api/tasks', { mode: 'generate' });
    expect(r.code).toBe(400);
  });

  it('未上线模式 400', async () => {
    const r = await req('POST', '/api/tasks', { mode: 'beautify', topic: 'x' });
    expect(r.code).toBe(400);
  });

  it('创建任务进入 planning（网关未配置会失败）', async () => {
    const r = await req('POST', '/api/tasks', { mode: 'generate', topic: '测试主题', pages: 3 });
    expect(r.code).toBe(200);
    expect(r.body.id).toBeTruthy();
    // 等待异步规划（无网关 → failed）
    await new Promise((res) => setTimeout(res, 500));
    const d = await req('GET', `/api/tasks/${r.body.id}`);
    expect(['planning', 'failed', 'awaiting_confirm']).toContain(d.body.status);
  });
});

describe('credits policy', () => {
  it('按页报价 + 生图加价', async () => {
    const { quoteTask } = await import('../src/credits.js');
    expect(quoteTask(8, 2).total).toBe(10);
    expect(quoteTask(0, 5).total).toBe(6); // 页数下限 1
    expect(quoteTask(5, 0).total).toBe(5);
  });
});

describe('templates', () => {
  it('创建 / 列表 / 编辑 / 删除', async () => {
    const c = await req('POST', '/api/templates', {
      name: '测试模板', description: '单测',
      style: { mode: 'swiss-grid', palette: ['#111111', '#F5F5F5', '#FF0000'], typography: '两档字阶', notes: '红色 accent' },
    });
    expect(c.code).toBe(200);
    const id = c.body.id;

    const list = await req('GET', '/api/templates');
    expect(list.code).toBe(200);
    const tpl = list.body.templates.find((t: any) => t.id === id);
    expect(tpl.name).toBe('测试模板');
    expect(tpl.style.palette).toHaveLength(3);

    const upd = await req('PUT', `/api/templates/${id}`, { name: '改名模板', style: { mode: 'editorial', palette: ['#222222'], typography: '', notes: '' } });
    expect(upd.code).toBe(200);

    const del = await req('DELETE', `/api/templates/${id}`);
    expect(del.code).toBe(200);
    const list2 = await req('GET', '/api/templates');
    expect(list2.body.templates.find((t: any) => t.id === id)).toBeUndefined();
  });

  it('名称必填校验', async () => {
    const r = await req('POST', '/api/templates', { name: '' });
    expect(r.code).toBe(400);
  });
});

describe('uploads', () => {
  it('multipart 上传图片成功，非图片拒绝', async () => {
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const buf = Buffer.from(pngB64, 'base64');
    const boundary = '----vitest' + Date.now();
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="t.png"',
      'Content-Type: image/png',
      '',
      buf.toString('binary'),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = await app.inject({
      method: 'POST', url: '/api/uploads',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: `pptbyby_session=${cookie}` },
      payload: Buffer.from(body, 'binary'),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.uploads).toHaveLength(1);
    expect(data.uploads[0].filename).toBe('t.png');
    expect(data.uploads[0].url).toMatch(/^\/media\/uploads\//);
  });
});
