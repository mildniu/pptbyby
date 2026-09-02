import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.js';

// 简易 .env 加载（KEY=VALUE，# 注释），已存在的环境变量优先
const envFile = join(import.meta.dirname, '..', '..', '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const PORT = Number(process.env.PORT ?? 3400);
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), '..', 'data');
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD ?? '';
const SECRET_KEY = process.env.SECRET_KEY ?? '';

if (!ACCESS_PASSWORD) {
  console.error('错误：请在 .env 或环境变量设置 ACCESS_PASSWORD（admin 登录密码）');
  process.exit(1);
}
const secretKey = SECRET_KEY || randomBytes(32).toString('hex');
if (!SECRET_KEY) {
  console.warn('警告：未设置 SECRET_KEY，已随机生成。重启后登录态与已保存 API Key 将失效，请在 .env 固定它');
}

const app = await buildApp({ accessPassword: ACCESS_PASSWORD, secretKey, dataDir: DATA_DIR });

// 生产模式托管前端 dist
const distDir = process.env.WEB_DIST ?? join(import.meta.dirname, '..', '..', 'web', 'dist');
if (existsSync(distDir)) {
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, { root: distDir, prefix: '/' });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/media/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
}

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`PPTByBy 已启动: http://0.0.0.0:${PORT}  (数据目录: ${DATA_DIR})`);
