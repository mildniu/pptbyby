import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword } from './crypto.js';

export type Db = Database.Database;

export function openDb(dataDir: string): { db: Db; mediaDir: string } {
  const mediaDir = dataDir === ':memory:dir:' ? join('/tmp', `pptbyby-test-${process.pid}`) : join(dataDir, 'media');
  mkdirSync(mediaDir, { recursive: true });
  const dbFile = dataDir === ':memory:dir:' ? ':memory:' : join(dataDir, 'pptbyby.db');
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', -- 'admin' | 'user'
      status INTEGER NOT NULL DEFAULT 1, -- 1 active, 0 disabled
      credits INTEGER NOT NULL DEFAULT 20, -- 用户积分余额，默认 20
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'generate', -- generate | quick | beautify | edit_native | create_template | image_to_pptx
      status TEXT NOT NULL DEFAULT 'planning',
      -- planning(大纲生成中) -> awaiting_confirm(待确认) -> generating(逐页生成中)
      -- -> exporting(导出中) -> done | failed | cancelled
      topic TEXT NOT NULL DEFAULT '',
      source_text TEXT NOT NULL DEFAULT '',
      params_json TEXT NOT NULL DEFAULT '{}',
      spec_json TEXT,            -- LLM 产出的设计规格 + 大纲（待确认/已确认）
      progress_json TEXT NOT NULL DEFAULT '{}', -- { phase, currentPage, totalPages, pages: [{id,status,error}], images: [...] }
      result_path TEXT,
      error TEXT,
      credits_cost INTEGER NOT NULL DEFAULT 0,  -- 已结算积分
      credits_held INTEGER NOT NULL DEFAULT 0,  -- 预扣积分
      created_at INTEGER NOT NULL,
      done_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS credit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      task_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      path TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      style_json TEXT NOT NULL DEFAULT '{}', -- {mode, palette[], typography, notes}
      cover_svg TEXT,           -- 封面页示例 SVG（可选）
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // 迁移：老表补列
  try {
    const info = db.pragma('table_info(tasks)') as any[];
    for (const [col, ddl] of [
      ['spec_json', 'TEXT'],
      ['progress_json', "TEXT NOT NULL DEFAULT '{}'"],
      ['credits_held', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      if (!info.some((c) => c.name === col)) {
        db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${ddl}`);
      }
    }
  } catch {}

  // 默认 admin 账号（密码见 ecosystem.config.json 的 ACCESS_PASSWORD，首次启动写入）
  const admin = db.prepare("SELECT id FROM users WHERE id='admin'").get() as { id: string } | undefined;
  if (!admin) {
    const pw = process.env.ACCESS_PASSWORD || 'woshiniu2';
    db.prepare('INSERT INTO users(id, username, password_hash, role, credits, created_at) VALUES (?,?,?,?,?,?)').run(
      'admin', 'admin', hashPassword(pw), 'admin', 100000, Date.now()
    );
  }

  return { db, mediaDir };
}
