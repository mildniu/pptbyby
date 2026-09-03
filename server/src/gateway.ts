import type { Db } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { log, logError } from './logger.js';
import { request } from 'undici';

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  imageModel: string;
  tavilyKey: string;   // Tavily 搜索 API Key（tvly-…，可选）
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
    tavilyKey: getVal(userId, 'tavilyKey'),
  };
  const hasOwn = !!(own.baseUrl && own.encApiKey);

  let { baseUrl, encApiKey, chatModel, imageModel, tavilyKey } = own;
  if (userId !== 'admin' && !hasOwn) {
    if (!baseUrl) baseUrl = getVal('admin', 'baseUrl');
    if (!encApiKey) encApiKey = getVal('admin', 'apiKey');
    if (!chatModel) chatModel = getVal('admin', 'chatModel');
    if (!imageModel) imageModel = getVal('admin', 'imageModel');
    if (!tavilyKey) tavilyKey = getVal('admin', 'tavilyKey');
  }

  return {
    baseUrl: (baseUrl ?? '').trim().replace(/\/+$/, ''),
    apiKey: encApiKey ? (decrypt(encApiKey, secretKey) ?? '') : '',
    chatModel: chatModel ?? '',
    imageModel: imageModel ?? '',
    tavilyKey: tavilyKey ?? '',
    isCustom: userId === 'admin' || hasOwn,
  };
}

export function saveUserGatewayConfig(
  db: Db,
  userId: string,
  secretKey: string,
  input: Partial<Pick<GatewayConfig, 'baseUrl' | 'apiKey' | 'chatModel' | 'imageModel' | 'tavilyKey'>>,
): GatewayConfig {
  const cur = getUserGatewayConfig(db, userId, secretKey);
  const next = {
    baseUrl: (input.baseUrl !== undefined ? input.baseUrl : cur.baseUrl).trim().replace(/\/+$/, ''),
    apiKey:
      input.apiKey && input.apiKey.includes('*') ? cur.apiKey : (input.apiKey !== undefined ? input.apiKey : cur.apiKey).trim(),
    chatModel: (input.chatModel !== undefined ? input.chatModel : cur.chatModel).trim(),
    imageModel: (input.imageModel !== undefined ? input.imageModel : cur.imageModel).trim(),
    tavilyKey:
      input.tavilyKey && input.tavilyKey.includes('*')
        ? cur.tavilyKey
        : (input.tavilyKey !== undefined ? input.tavilyKey : cur.tavilyKey)
            .split(/[\n,，\s]+/).map((k) => k.trim()).filter(Boolean).join(','),
  };

  const upsert = db.prepare(
    'INSERT INTO user_settings(user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value'
  );
  upsert.run(userId, 'baseUrl', next.baseUrl);
  upsert.run(userId, 'chatModel', next.chatModel);
  upsert.run(userId, 'imageModel', next.imageModel);
  if (input.tavilyKey !== undefined) upsert.run(userId, 'tavilyKey', next.tavilyKey);
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

/** OpenAI 兼容 chat 调用（走网关，模型用户自定义）。
 *  思考型模型（如 glm-5.3）面对大规范文档会把 max_tokens 全耗在 reasoning 上导致 content 为空，
 *  因此默认携带 reasoning_effort: low；网关若拒绝该参数（400）则去掉后重试一次。 */
export async function chatCompletion(
  cfg: GatewayConfig,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number; reasoningEffort?: string | null } = {},
): Promise<string> {
  const model = cfg.chatModel;
  if (!cfg.baseUrl || !cfg.apiKey || !model) throw new Error('网关未配置完整（baseUrl / apiKey / chatModel）');

  const call = async (withReasoningEffort: boolean) => {
    const payload: Record<string, unknown> = {
      model,
      messages,
      max_tokens: opts.maxTokens ?? 8192,
      temperature: opts.temperature ?? 0.7,
    };
    if (withReasoningEffort) payload.reasoning_effort = opts.reasoningEffort ?? 'low';
    return request(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      headersTimeout: opts.timeoutMs ?? 600000,
      bodyTimeout: opts.timeoutMs ?? 600000,
    });
  };

  let res = await call(true);
  if (res.statusCode === 400) {
    // 网关可能不认识 reasoning_effort 参数，去掉重试一次
    log('LLM', '携带 reasoning_effort 收到 400，去掉参数重试');
    res = await call(false);
  }
  const body = (await res.body.json()) as any;
  if (res.statusCode !== 200) {
    logError('LLM', `chat 调用失败 HTTP ${res.statusCode}`, body);
    throw new Error(`LLM 调用失败 (${res.statusCode}): ${JSON.stringify(body?.error ?? body).slice(0, 300)}`);
  }
  const msg = body?.choices?.[0]?.message;
  const content = msg?.content;
  if (typeof content !== 'string' || !content) {
    const reasoningLen = typeof msg?.reasoning_content === 'string' ? msg.reasoning_content.length : 0;
    const finish = body?.choices?.[0]?.finish_reason;
    if (reasoningLen > 0 && finish === 'length') {
      throw new Error(`模型把 ${opts.maxTokens ?? 8192} max_tokens 全部耗在思考上（reasoning ${reasoningLen} 字符，content 为空）。请在网关设置中更换模型或降低思考强度`);
    }
    throw new Error('LLM 返回为空');
  }
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

// ---------------------------------------------------------------------------
// Tavily 搜索（主题研究用，可选配置）
// ---------------------------------------------------------------------------

export interface TavilyResult {
  title: string;
  url: string;
  content: string; // 摘要片段
}

/** Tavily search API：返回带摘要的搜索结果 */
export async function tavilySearch(cfg: GatewayConfig, query: string, opts: { maxResults?: number } = {}): Promise<TavilyResult[]> {
  if (!cfg.tavilyKey) throw new Error('未配置 Tavily API Key');
  const res = await request('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: cfg.tavilyKey,
      query,
      max_results: opts.maxResults ?? 5,
      include_answer: false,
    }),
    headersTimeout: 30000,
    bodyTimeout: 30000,
  });
  const body = (await res.body.json()) as any;
  if (res.statusCode !== 200) {
    logError('TAVILY', `搜索失败 HTTP ${res.statusCode}`, body);
    throw new Error(`Tavily 搜索失败 (${res.statusCode}): ${JSON.stringify(body?.detail ?? body).slice(0, 200)}`);
  }
  return (body?.results ?? []).map((r: any) => ({
    title: String(r.title ?? ''),
    url: String(r.url ?? ''),
    content: String(r.content ?? ''),
  }));
}

/** 测试 Tavily Key 是否有效 */
export async function testTavilyKey(cfg: GatewayConfig): Promise<boolean> {
  if (!cfg.tavilyKey) return false;
  try {
    const results = await tavilySearch(cfg, 'test', { maxResults: 1 });
    return Array.isArray(results);
  } catch {
    return false;
  }
}
