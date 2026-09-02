import type { Db } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { log, logError } from './logger.js';
import { request } from 'undici';

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  imageModel: string;
  isCustom?: boolean; // 用户专属配置（免继承）
}

/** 读取某用户的网关配置（apiKey 解密；非 admin 未配置时继承 admin 全局配置） */
export function getUserGatewayConfig(db: Db, userId: string, secretKey: string): GatewayConfig {
  const getVal = (uid: string, k: string) => {
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(uid, k) as { value: string } | undefined;
    return row?.value;
  };

  const own = {
    baseUrl: getVal(userId, 'baseUrl'),
    encApiKey: getVal(userId, 'apiKey'),
    chatModel: getVal(userId, 'chatModel'),
    imageModel: getVal(userId, 'imageModel'),
  };
  const hasOwn = !!(own.baseUrl && own.encApiKey);

  let { baseUrl, encApiKey, chatModel, imageModel } = own;
  if (userId !== 'admin' && !hasOwn) {
    if (!baseUrl) baseUrl = getVal('admin', 'baseUrl');
    if (!encApiKey) encApiKey = getVal('admin', 'apiKey');
    if (!chatModel) chatModel = getVal('admin', 'chatModel');
    if (!imageModel) imageModel = getVal('admin', 'imageModel');
  }

  return {
    baseUrl: (baseUrl ?? '').trim().replace(/\/+$/, ''),
    apiKey: encApiKey ? (decrypt(encApiKey, secretKey) ?? '') : '',
    chatModel: chatModel ?? '',
    imageModel: imageModel ?? '',
    isCustom: userId === 'admin' || hasOwn,
  };
}

export function saveUserGatewayConfig(
  db: Db,
  userId: string,
  secretKey: string,
  input: Partial<Pick<GatewayConfig, 'baseUrl' | 'apiKey' | 'chatModel' | 'imageModel'>>,
): GatewayConfig {
  const cur = getUserGatewayConfig(db, userId, secretKey);
  const next = {
    baseUrl: (input.baseUrl !== undefined ? input.baseUrl : cur.baseUrl).trim().replace(/\/+$/, ''),
    apiKey:
      input.apiKey && input.apiKey.includes('*') ? cur.apiKey : (input.apiKey !== undefined ? input.apiKey : cur.apiKey).trim(),
    chatModel: (input.chatModel !== undefined ? input.chatModel : cur.chatModel).trim(),
    imageModel: (input.imageModel !== undefined ? input.imageModel : cur.imageModel).trim(),
  };

  const upsert = db.prepare(
    'INSERT INTO user_settings(user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value'
  );
  upsert.run(userId, 'baseUrl', next.baseUrl);
  upsert.run(userId, 'chatModel', next.chatModel);
  upsert.run(userId, 'imageModel', next.imageModel);
  if (input.apiKey && !input.apiKey.includes('*')) {
    upsert.run(userId, 'apiKey', next.apiKey ? encrypt(next.apiKey, secretKey) : '');
  } else if (input.apiKey === '') {
    upsert.run(userId, 'apiKey', '');
  }

  log('CONFIG', `用户 [${userId}] 更新了网关设置`, { baseUrl: next.baseUrl, chatModel: next.chatModel, imageModel: next.imageModel });
  return getUserGatewayConfig(db, userId, secretKey);
}

export function clearUserGatewayConfig(db: Db, userId: string): void {
  db.prepare('DELETE FROM user_settings WHERE user_id=?').run(userId);
  log('CONFIG', `用户 [${userId}] 清除了自定义专属网关配置，已恢复继承平台共享接口`);
}

/** 列出网关可用模型（OpenAI 兼容 /v1/models） */
export async function listGatewayModels(cfg: GatewayConfig): Promise<string[]> {
  if (!cfg.baseUrl || !cfg.apiKey) return [];
  try {
    const res = await request(`${cfg.baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      headersTimeout: 15000,
      bodyTimeout: 15000,
    });
    if (res.statusCode !== 200) return [];
    const body = (await res.body.json()) as any;
    return (body?.data ?? []).map((m: any) => m.id).filter(Boolean).sort();
  } catch {
    return [];
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** OpenAI 兼容 chat 调用（走网关，模型用户自定义） */
export async function chatCompletion(
  cfg: GatewayConfig,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  const model = cfg.chatModel;
  if (!cfg.baseUrl || !cfg.apiKey || !model) throw new Error('网关未配置完整（baseUrl / apiKey / chatModel）');
  const res = await request(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 8192,
      temperature: opts.temperature ?? 0.7,
    }),
    headersTimeout: opts.timeoutMs ?? 600000,
    bodyTimeout: opts.timeoutMs ?? 600000,
  });
  const body = (await res.body.json()) as any;
  if (res.statusCode !== 200) {
    logError('LLM', `chat 调用失败 HTTP ${res.statusCode}`, body);
    throw new Error(`LLM 调用失败 (${res.statusCode}): ${JSON.stringify(body?.error ?? body).slice(0, 300)}`);
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content) throw new Error('LLM 返回为空');
  return content;
}

/** OpenAI 兼容生图调用，返回 b64 */
export async function generateImage(cfg: GatewayConfig, prompt: string, opts: { size?: string } = {}): Promise<string> {
  const model = cfg.imageModel;
  if (!cfg.baseUrl || !cfg.apiKey || !model) throw new Error('网关未配置完整（baseUrl / apiKey / imageModel）');
  const res = await request(`${cfg.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      size: opts.size ?? '1536x864',
      n: 1,
      response_format: 'b64_json',
    }),
    headersTimeout: 300000,
    bodyTimeout: 300000,
  });
  const body = (await res.body.json()) as any;
  if (res.statusCode !== 200) {
    logError('IMAGE', `生图失败 HTTP ${res.statusCode}`, body);
    throw new Error(`生图失败 (${res.statusCode}): ${JSON.stringify(body?.error ?? body).slice(0, 300)}`);
  }
  const b64 = body?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !b64) throw new Error('生图返回为空');
  return b64;
}
