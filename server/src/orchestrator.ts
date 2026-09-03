import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Db } from './db.js';
import { getUserGatewayConfig, chatCompletion, type GatewayConfig, type ChatMessage } from './gateway.js';
import { builtinSpecText } from './builtinTemplates.js';
import { runPython, qualityCheck, initProject, SKILL_DIR } from './pipeline.js';
import { quoteTask, CREDITS_PER_PAGE, CREDITS_PER_IMAGE } from './credits.js';
import { log, logError } from './logger.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// 任务模式与状态
// ---------------------------------------------------------------------------

export type TaskMode = 'generate' | 'quick' | 'beautify' | 'edit_native' | 'create_template' | 'image_to_pptx';
export const TASK_MODES: { id: TaskMode; name: string; desc: string; ready: boolean }[] = [
  { id: 'generate', name: '生成 PPT', desc: '主题/文档 → 大纲确认 → 逐页生成可编辑 PPTX', ready: true },
  { id: 'quick', name: '快速生成', desc: '跳过大纲确认，一步直出 PPTX', ready: true },
  { id: 'beautify', name: '美化 PPT', desc: '上传 PPTX，保持页数/顺序/措辞重排视觉', ready: true },
  { id: 'edit_native', name: '编辑 PPT', desc: '上传 PPTX，保留原设计只改内容', ready: true },
  { id: 'create_template', name: '创建模板', desc: '从参考稿蒸馏品牌/风格/版式模板', ready: true },
  { id: 'image_to_pptx', name: '图片转 PPT', desc: '页面截图重建为可编辑 PPT', ready: true },
];

export interface PageSpec {
  id: string;
  role: string; // cover | toc | content | section | data | closing ...
  title: string;
  outline: string;
}

export interface ImageSpec {
  id: string;
  desc: string;
  usage: string;
  origin: 'ai' | 'user'; // AI 生成 / 用户上传
  page_role?: 'hero_page' | 'local'; // 上游 image-generator 语义
  text_policy?: 'none' | 'embedded';
  file?: string;
  status: 'pending' | 'generating' | 'done' | 'failed' | 'ready'; // user 图片直接 ready
  error?: string;
}

export interface DesignSpec {
  title: string;
  format: string;
  templateId?: string | null;
  pages: PageSpec[];
  images: ImageSpec[];
  style: {
    mode: string;
    palette: string[];
    typography: string;
    notes: string;
  };
}

// ---------------------------------------------------------------------------
// 进度模型：phase + 步骤时间线（前端逐步骤可点查看）
// ---------------------------------------------------------------------------

export type StepKey = 'plan' | 'assets' | 'pages' | 'inspect' | 'export';

export interface StepProgress {
  key: StepKey;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt?: number;
  endedAt?: number;
  message?: string;
}

interface PageProgress {
  id: string;
  title: string;
  role: string;
  status: 'pending' | 'generating' | 'ok' | 'failed';
  error?: string;      // 最后一次质检/生成错误
  retries?: number;     // 重试次数
  attempts?: string[];  // 每次尝试的错误（时间线细节）
}

export interface TaskProgress {
  phase: string;
  currentPage: number;
  totalPages: number;
  steps: StepProgress[];
  pages: PageProgress[];
  /** 项目目录名（前端拼 /media 用） */
  projectDir?: string;
  message?: string;
}

const STEP_DEFS: { key: StepKey; label: string }[] = [
  { key: 'plan', label: '规划大纲' },
  { key: 'assets', label: '准备素材' },
  { key: 'pages', label: '逐页生成' },
  { key: 'inspect', label: '质量终检' },
  { key: 'export', label: '导出 PPTX' },
];

export function initialSteps(pages?: number): StepProgress[] {
  return STEP_DEFS.map((s) => ({ key: s.key, label: s.label, status: 'pending' as const }));
}

// ---------------------------------------------------------------------------
// Prompt 素材（vendor 的 skill 参考文档，按需懒加载缓存）
// ---------------------------------------------------------------------------

const refCache = new Map<string, string>();
function loadRef(...parts: string[]): string {
  const rel = join('references', ...parts);
  if (!refCache.has(rel)) {
    refCache.set(rel, readFileSync(join(SKILL_DIR, rel), 'utf8'));
  }
  return refCache.get(rel)!;
}

// ---------------------------------------------------------------------------
// 任务行访问与进度更新
// ---------------------------------------------------------------------------

export interface TaskRow {
  id: string;
  user_id: string;
  mode: string;
  status: string;
  topic: string;
  source_text: string;
  params_json: string;
  spec_json: string | null;
  progress_json: string;
  result_path: string | null;
  error: string | null;
  credits_cost: number;
  credits_held: number;
  created_at: number;
  done_at: number | null;
}

export interface OrchestratorDeps {
  db: Db;
  secretKey: string;
  dataDir: string;
}

const running = new Set<string>();

export function getTask(deps: OrchestratorDeps, id: string): TaskRow | undefined {
  return deps.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow | undefined;
}

export function updateTask(deps: OrchestratorDeps, id: string, patch: Partial<TaskRow>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const setSql = keys.map((k) => `${k}=?`).join(', ');
  deps.db.prepare(`UPDATE tasks SET ${setSql} WHERE id=?`).run(...keys.map((k) => (patch as any)[k]), id);
}

export function setProgress(deps: OrchestratorDeps, id: string, progress: TaskProgress): void {
  updateTask(deps, id, { progress_json: JSON.stringify(progress) });
}

/** 在现有进度上更新某个步骤状态 */
export function setStep(deps: OrchestratorDeps, id: string, key: StepKey, status: StepProgress['status'], message?: string): void {
  const p = currentProgress(deps, id);
  if (!p.steps) p.steps = initialSteps();
  const s = p.steps.find((x) => x.key === key);
  if (!s) return;
  if (status === 'running' && !s.startedAt) s.startedAt = Date.now();
  if (status === 'done' || status === 'failed' || status === 'skipped') s.endedAt = Date.now();
  s.status = status;
  if (message !== undefined) s.message = message;
  // 同步顶层 message 给进度条（running 时展示当前步骤的实时消息）
  if (status === 'running' && message !== undefined) p.message = message;
  setProgress(deps, id, p);
}

// ---------------------------------------------------------------------------
// 积分：预扣 / 结算 / 退回
// ---------------------------------------------------------------------------

export function holdCredits(deps: OrchestratorDeps, userId: string, taskId: string, amount: number): void {
  if (amount <= 0) return;
  const ok = deps.db
    .prepare('UPDATE users SET credits = credits - ? WHERE id=? AND credits >= ?')
    .run(amount, userId, amount);
  if (ok.changes === 0) throw new Error(`积分不足：需要 ${amount}，请先充值或减少页数`);
  deps.db.prepare('INSERT INTO credit_logs(user_id, delta, reason, task_id, created_at) VALUES (?,?,?,?,?)').run(
    userId, -amount, '任务预扣', taskId, Date.now()
  );
  updateTask(deps, taskId, { credits_held: (getTask(deps, taskId)?.credits_held ?? 0) + amount });
}

export function refundCredits(deps: OrchestratorDeps, userId: string, taskId: string, amount: number, reason: string): void {
  if (amount <= 0) return;
  deps.db.prepare('UPDATE users SET credits = credits + ? WHERE id=?').run(amount, userId);
  deps.db.prepare('INSERT INTO credit_logs(user_id, delta, reason, task_id, created_at) VALUES (?,?,?,?,?)').run(
    userId, amount, reason, taskId, Date.now()
  );
  const t = getTask(deps, taskId);
  updateTask(deps, taskId, {
    credits_held: Math.max(0, (t?.credits_held ?? 0) - amount),
    credits_cost: t?.credits_cost ?? 0,
  });
}

export function settleCredits(deps: OrchestratorDeps, userId: string, taskId: string, actual: number): void {
  const t = getTask(deps, taskId);
  if (!t) return;
  const held = t.credits_held;
  if (actual < held) {
    refundCredits(deps, userId, taskId, held - actual, '结算退还（未产出部分）');
  } else if (actual > held) {
    // 实际超出预扣（不应发生，防御性补扣）
    const ok = deps.db.prepare('UPDATE users SET credits = credits - ? WHERE id=? AND credits >= ?').run(actual - held, userId, actual - held);
    if (ok.changes > 0) {
      deps.db.prepare('INSERT INTO credit_logs(user_id, delta, reason, task_id, created_at) VALUES (?,?,?,?,?)').run(
        userId, -(actual - held), '结算补扣', taskId, Date.now()
      );
    }
  }
  updateTask(deps, taskId, { credits_cost: actual, credits_held: 0 });
}

// ---------------------------------------------------------------------------
// LLM 输出解析
// ---------------------------------------------------------------------------

/** 从 LLM 回复中抽取 JSON（容忍 ```json 围栏与前后噪声） */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text].filter(Boolean) as string[];
  for (const c of candidates) {
    const start = c.search(/[{[]/);
    if (start < 0) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    const end = c.lastIndexOf(close);
    if (end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1)) as T;
    } catch { /* 下一个候选 */ }
  }
  throw new Error(`无法从 LLM 输出解析 JSON：${text.slice(0, 200)}`);
}

/** 从 LLM 回复中抽取 SVG（容忍围栏） */
export function extractSvg(text: string): string {
  const fenced = text.match(/```(?:svg|xml)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf('<svg');
  const end = raw.lastIndexOf('</svg>');
  if (start < 0 || end < 0) throw new Error('LLM 输出中未找到 <svg> 元素');
  return raw.slice(start, end + 6).trim();
}

// ---------------------------------------------------------------------------
// 阶段 1：规划（Strategist 蒸馏）
// ---------------------------------------------------------------------------

const STRATEGIST_SYSTEM = `你是一位资深演示设计策略师（Strategist）。你将根据用户的主题/材料规划一份 PPT。
你必须只输出一个 JSON 对象（可放在 \`\`\`json 围栏内），不要输出任何其他文字。

JSON 结构：
{
  "title": "演示标题",
  "style": {
    "mode": "视觉模式（如 corporate / editorial / swiss-grid / glassmorphism / dark-data 等，自选最贴合主题的）",
    "palette": ["#RRGGBB", "#RRGGBB", "#RRGGBB", "#RRGGBB"],
    "typography": "字体策略描述（层级/对比/密度的简要说明）",
    "notes": "跨页一致性说明：贯穿的 motif、强调色用法等"
  },
  "pages": [
    { "id": "p01", "role": "cover", "title": "封面主标题", "outline": "本页要呈现的内容要点与信息层级描述" },
    { "id": "p02", "role": "toc", "title": "...", "outline": "..." }
  ],
  "images": [
    { "id": "img01", "desc": "图像主题与视觉内容描述（英文散文，具体视觉名词，不含布局指令）", "usage": "p01 封面 hero 图（page_role: hero_page）", "page_role": "hero_page|local", "text_policy": "none|embedded" }
  ]
}

规则：
- pages 数量必须等于用户要求的页数（若用户没有指定页数，则由你根据内容的充实程度决定，一般 6-12 页）；第一页 role=cover，最后一页 role=closing，中间按内容逻辑安排 toc/section/content/data。
- outline 要写得足以让另一位设计执行者在没有上下文的情况下完成该页：包含该页的论点、数据、层级结构。
- images 每页至多 1 张，全篇 0-4 张；只在真正提升表达时使用（封面 hero、关键场景图）。不需要图片就给空数组。用户上传了素材图片时优先使用用户图片（用对应文件名标注 origin 为 user），仅在确有缺口时补充 AI 生成图。
- IMAGE_MODE_RULE（优先级高于上一条）：image_mode 为 "none" 时 images 必须为空数组（纯排版，不用任何 AI 配图，用户上传素材仍可用）；为 "every" 时每页都安排 1 张配图（除结尾页可选）；为 "auto" 或缺省时按上一条智能判断。
- palette 给 3-5 个协调的六位十六进制色（大写 #RRGGBB），含背景/主文字/强调色。
- 若用户给了源材料，内容必须忠于材料事实，不得编造数据。
- 若指定了模板风格约束，style 必须严格遵循模板的 mode/palette/typography，不得偏离。
- 模板约束中若含「封面背景色实测为 #XXXXXX（原型第1页真实底色…）」，封面底色必须用该实测值；style.notes 里若与此冲突的封面描述一律以实测为准。`;

interface TemplateStyle {
  mode: string;
  palette: string[];
  typography: string;
  notes: string;
}

export async function planTask(deps: OrchestratorDeps, taskId: string): Promise<void> {
  const t = getTask(deps, taskId);
  if (!t) return;
  const cfg = getUserGatewayConfig(deps.db, t.user_id, deps.secretKey);
  const params = JSON.parse(t.params_json || '{}');

  const progress: TaskProgress = {
    phase: 'planning', currentPage: 0, totalPages: params.pages ?? 0,
    steps: initialSteps(), pages: [], message: '正在规划大纲…',
  };
  const planStep = progress.steps.find((s) => s.key === 'plan')!;
  planStep.status = 'running';
  planStep.startedAt = Date.now();
  setProgress(deps, taskId, progress);

  // 模板风格约束（自定义模板 或 vendor 内置模板 design_spec 全文）
  let templateConstraint = '';
  if (params.templateId) {
    // 统一走 templates 表（内置模板已同步入库：spec_md + deck 原型/素材按新规则）
    const tpl = deps.db.prepare('SELECT * FROM templates WHERE id=?').get(params.templateId) as any;
    if (!tpl && String(params.templateId).startsWith('builtin:')) {
      // 兜底：表未同步时直接读 pipeline 的 design_spec
      const specText = builtinSpecText(String(params.templateId));
      if (specText) {
        templateConstraint = `\n模板规范（必须严格遵循以下 design_spec 全文）：\n<template_spec>\n${specText}\n</template_spec>`;
      }
    } else if (tpl) {
      // 首选上游标准载体 design_spec.md（蒸馏/内置同步均产出）；老模板回退 style JSON
      if (tpl.spec_md) {
          let constraint = `\n模板规范（ppt-master 标准 design_spec，必须严格遵循全文）：\n<template_spec>\n${tpl.spec_md}\n</template_spec>`;
          // deck：按上游 strategist-template 契约附 Page Roster + 脱敏原型全文供 Executor 参照版式
          if ((tpl.kind ?? 'style') === 'deck' && tpl.pages_json) {
            try {
              const pages: string[] = JSON.parse(tpl.pages_json);
              const roster = tpl.spec_md.split('## V. Page Roster')[1]?.split('\n## ')[0] ?? '';
              const protos = pages.slice(0, 8).map((svg, i) =>
                `=== 原型 ${String(i + 1).padStart(2, '0')} ===\n${svg.slice(0, 12000)}`
              ).join('\n\n');
              constraint += `\n\n## Page Roster（页面角色与版式，规划时按此分配页面）\n${roster}\n\n## 原型 SVG（脱敏版式参考；生成页面须遵循对应原型的版式结构与视觉元素，内容用新主题）：\n${protos}`;
            } catch { /* ignore */ }
          }
          templateConstraint = constraint;
        } else {
          const style = JSON.parse(tpl.style_json || '{}');
          templateConstraint = `\n模板风格约束（必须严格遵循）：${tpl.name} — ${JSON.stringify(style)}`;
        }
    }
  }

  // 用户上传素材描述（若有）
  let assetNote = '';
  if (Array.isArray(params.assetIds) && params.assetIds.length) {
    const marks = params.assetIds.map(() => '?').join(',');
    const rows = deps.db.prepare(`SELECT u.id, u.filename FROM uploads u WHERE u.id IN (${marks})`).all(...params.assetIds) as any[];
    if (rows.length) {
      assetNote = `\n用户已上传素材图片（images 列表中把它们列为 origin:"user"，usage 写建议用途，status 由系统管理）：\n${rows.map((r) => `- ${r.id}（文件 ${r.filename}）`).join('\n')}`;
    }
  }

  // Tavily 主题研究（可选）：主题型任务且用户开启时，先搜索补充事实。
  // 计费：自己的 Key 免费；用平台（继承的）Key 每次搜索 1 积分
  let researchNote = '';
  if (params.research && cfg.tavilyKey && t.topic) {
    const usingOwnKey = cfg.tavilyKeyOwn === true;
    const p0 = currentProgress(deps, taskId);
    const st0 = p0.steps.find((x) => x.key === 'plan');
    if (st0) st0.message = '正在联网搜索补充资料…';
    setProgress(deps, taskId, p0);
    try {
      // 官方 tavily_search.py（多 Key 池 + failover），Key 经环境变量传入
      const r = await runPython('tavily_search.py', [t.topic.slice(0, 200), '--depth', 'advanced', '--max-results', '6', '--json'], {
        timeoutMs: 90000,
        env: { TAVILY_API_KEYS: cfg.tavilyKey },
      });
      if (r.code === 0 && !usingOwnKey) {
        // 平台 Key 搜索：1 积分/次（即时消耗，直接扣余额，不进预扣/退还体系）
        try {
          deps.db.prepare('UPDATE users SET credits = credits - 1 WHERE id=? AND credits >= 1').run(t.user_id);
          deps.db.prepare('INSERT INTO credit_logs(user_id, delta, reason, task_id, created_at) VALUES (?,?,?,?,?)').run(
            t.user_id, -1, '联网搜索（平台 Key）', taskId, Date.now()
          );
          updateTask(deps, taskId, { credits_cost: (getTask(deps, taskId)?.credits_cost ?? 0) + 1 });
          log('ORCH', `任务 ${taskId} 平台 Key 搜索扣 1 积分`);
        } catch (e: any) {
          logError('ORCH', `任务 ${taskId} 平台搜索扣积分失败（余额不足）`, e?.message);
        }
      }
      if (r.code === 0) {
        let results: any[] = [];
        try { results = JSON.parse(r.stdout.slice(r.stdout.indexOf('['), r.stdout.lastIndexOf(']') + 1)) ?? []; } catch { /* keep [] */ }
        if (results.length) {
          researchNote = `\n联网研究补充（Tavily，供参考，优先级低于用户材料）：\n${results
            .map((x: any) => `- ${x.title ?? ''}（${x.url ?? ''}）：${String(x.content ?? '').slice(0, 300)}`)
            .join('\n')}`;
          log('ORCH', `任务 ${taskId} Tavily 研究完成，${results.length} 条结果`);
        }
      } else {
        logError('ORCH', `任务 ${taskId} Tavily 脚本失败`, r.stderr.slice(0, 200));
      }
    } catch (e: any) {
      logError('ORCH', `任务 ${taskId} Tavily 研究失败（继续无搜索规划）`, e?.message);
    }
  }

  const pagesReq = Number(params.pages) > 0 ? `${Number(params.pages)} 页` : '页数由你决定（根据内容充实程度，6-12 页）';
  const imageMode = ['auto', 'none', 'every'].includes(params.imageMode) ? params.imageMode : 'auto';
  const userMsg = [
    `主题：${t.topic || '（见源材料）'}`,
    `image_mode: ${imageMode}`,
    t.source_text ? `\n源材料：\n${t.source_text.slice(0, 60000)}` : '',
    researchNote,
    `\n要求：${pagesReq}，格式 ${params.format ?? 'ppt169'}，风格偏好：${params.styleHint || '自由发挥'}`,
    templateConstraint,
    assetNote,
    params.audience ? `受众：${params.audience}` : '',
    params.language ? `输出语言：${params.language}` : '',
  ].filter(Boolean).join('\n');

  try {
    const out = await chatCompletion(cfg, [
      { role: 'system', content: STRATEGIST_SYSTEM },
      { role: 'user', content: userMsg },
    ], { maxTokens: 8192, temperature: 0.6 });

    const spec = extractJson<DesignSpec>(out);
    if (!Array.isArray(spec.pages) || !spec.pages.length) throw new Error('大纲没有页面');
    spec.format = params.format ?? 'ppt169';
    // imageMode=every：确保每页（结尾页除外）都有 1 张 AI 配图
    if (imageMode === 'every') {
      spec.pages.forEach((pg, i) => {
        if (pg.role === 'closing' || pg.role === 'ending') return;
        if (spec.images.some((im) => im.usage.includes(pg.id))) return;
        spec.images.push({
          id: `img_${pg.id}`,
          desc: `Editorial hero image for the page "${pg.title}": ${pg.outline.slice(0, 120)}. High quality, relevant to the topic, suitable as a slide illustration.`,
          usage: `${pg.id} ${pg.title} 配图`,
          origin: 'ai',
          status: 'pending',
        });
      });
    }
    spec.templateId = params.templateId ?? null;
    spec.images = Array.isArray(spec.images) ? spec.images
      .filter((im) => imageMode !== 'none' || im.origin === 'user') // none 模式只留用户素材
      .map((im, i) => ({
        ...im,
        id: im.id || `img${String(i + 1).padStart(2, '0')}`,
        origin: im.origin === 'user' ? 'user' : 'ai',
        status: 'pending' as ImageSpec['status'],
      })) : [];

    setStep(deps, taskId, 'plan', 'done', `${spec.pages.length} 页大纲已生成`);

    // mode=quick：跳过用户确认直接执行
    if (t.mode === 'quick') {
      updateTask(deps, taskId, { spec_json: JSON.stringify(spec), status: 'generating' });
      await startExecution(deps, taskId, spec);
    } else {
      updateTask(deps, taskId, { spec_json: JSON.stringify(spec), status: 'awaiting_confirm' });
      setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'awaiting_confirm', totalPages: spec.pages.length, message: '大纲已就绪，等待确认' });
    }
  } catch (e: any) {
    logError('ORCH', `任务 ${taskId} 规划失败`, e?.message);
    setStep(deps, taskId, 'plan', 'failed', String(e?.message ?? e));
    updateTask(deps, taskId, { status: 'failed', error: `规划失败：${e?.message ?? e}`, done_at: Date.now() });
    setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'failed', message: String(e?.message ?? e) });
  }
}

// ---------------------------------------------------------------------------
// 阶段 2：执行（Executor 蒸馏：逐页 SVG → 质检回环 → 导出）
// ---------------------------------------------------------------------------

const EXECUTOR_SYSTEM_CACHE = { content: '' };
export function executorSystemPrompt(): string {
  if (!EXECUTOR_SYSTEM_CACHE.content) {
    // 按 ppt-master 上游 quick-generate §3「Direct SVG Authoring」的权威文件批次：
    // 核心批次 = shared-standards-core + executor-base + semantic-svg + preset-shape-vocabulary（完整读）；
    // svg-effects 是 executor-base 路由触发的条件模块（视觉作业超出日常块时）——附上供按需引用。
    EXECUTOR_SYSTEM_CACHE.content = [
      '你是 ppt-master 的 Executor（执行者）。按项目规范逐页手写 SVG。以下是必须严格遵守的技术规范文档（与上游 quick-generate 的核心批次一致）：',
      '',
      '=== 共享核心规范（shared-standards-core.md）===',
      loadRef('shared-standards-core.md'),
      '',
      '=== 执行者核心手册（executor-base.md）===',
      loadRef('executor-base.md'),
      '',
      '=== 语义标记（semantic-svg.md）===',
      loadRef('semantic-svg.md'),
      '',
      '=== 预设形状词汇表（preset-shape-vocabulary.md）===',
      loadRef('preset-shape-vocabulary.md'),
      '',
      '=== 高级效果与几何（svg-effects.md；executor-base 路由触发时使用）===',
      loadRef('svg-effects.md'),
    ].join('\n');
  }
  return EXECUTOR_SYSTEM_CACHE.content;
}

async function generatePageSvg(
  cfg: GatewayConfig,
  spec: DesignSpec,
  page: PageSpec,
  pageNum: number,
  totalPages: number,
  prevSummaries: string[],
  feedback?: string,
): Promise<string> {
  const userMsg = [
    feedback ? `上一次输出未通过质量检查，必须修复以下问题：\n${feedback}` : '',
    `设计规格（JSON）：${JSON.stringify({ title: spec.title, style: spec.style })}`,
    `本页规格：${JSON.stringify(page)}（第 ${pageNum}/${totalPages} 页）`,
    spec.images.length
      ? `可用图片资源（用 <image href="../images/文件名" .../> 引用，遵守 image 规范的 preserveAspectRatio 裁切约定）：${JSON.stringify(spec.images.filter((i) => i.status === 'done' || i.status === 'ready').map((i) => ({ file: i.file, usage: i.usage })))}`
      : '本项目没有图片资源，不要使用 <image>。',
    prevSummaries.length ? `已完成页面的简要摘要（保持视觉延续性，避免重复布局）：\n${prevSummaries.join('\n')}` : '',
    '',
    '输出：只输出这一页的完整 SVG 文档（1280×720 viewBox，遵守规范的全部 Required/Forbidden 边界）。不要输出任何解释文字。',
    '结构硬性要求：根元素声明 data-pptx-page-role（cover/toc/section/content/ending 之一）；每个逻辑内容单元包裹在页唯一的顶层 <g id="..."> 且带根坐标系 data-pptx-bounds="x y width height"（嵌套组不需要）；全幅背景矩形/图片不用包 <g>，直接给稳定 id 和 data-pptx-role="background"。',
  ].filter(Boolean).join('\n');

  const out = await chatCompletion(cfg, [
    { role: 'system', content: executorSystemPrompt() },
    { role: 'user', content: userMsg },
  ], { maxTokens: 16384, temperature: 0.8 });
  return extractSvg(out);
}

/** 从 SVG 中抽取简短摘要（标题文本 + 主要文字）供后续页保持延续性 */
function svgSummary(svg: string): string {
  const texts = [...svg.matchAll(/<text[^>]*>([^<]{2,60})</g)].map((m) => m[1].trim()).filter(Boolean);
  return texts.slice(0, 6).join(' / ').slice(0, 200);
}

/** 素材准备：用户上传图片复制进项目 images/；AI 图片逐张生成（含进度） */
async function prepareAssets(
  deps: OrchestratorDeps,
  taskId: string,
  cfg: GatewayConfig,
  spec: DesignSpec,
  projectPath: string,
  params: any,
): Promise<void> {
  const imgDir = join(projectPath, 'images');
  mkdirSync(imgDir, { recursive: true });

  // 1) 用户上传素材 → 复制进项目，LLM 引用文件名（与 spec.images 里 origin=user 行对应；
  //    未被规划引用的上传图也一并放入，供 Executor 选用）
  const uploadDir = join(deps.dataDir, 'uploads');
  const userAssets: { id: string; filename: string }[] = [];
  if (Array.isArray(params.assetIds) && params.assetIds.length && existsSync(uploadDir)) {
    const marks = params.assetIds.map(() => '?').join(',');
    const rows = deps.db.prepare(`SELECT id, filename, path FROM uploads WHERE id IN (${marks})`).all(...params.assetIds) as any[];
    for (const row of rows) {
      if (!existsSync(row.path)) continue;
      const safeName = `user_${row.id}${row.filename.match(/\.(png|jpe?g|webp|gif)$/i)?.[0] ?? '.png'}`.toLowerCase();
      copyFileSync(row.path, join(imgDir, safeName));
      userAssets.push({ id: row.id, filename: safeName });
    }
  }
  // 把用户图片登记进 spec.images（若 LLM 已列出同 id 则合并）
  for (const ua of userAssets) {
    const existing = spec.images.find((im) => im.origin === 'user' && (im.id === ua.id || im.file === ua.filename));
    if (existing) {
      existing.file = ua.filename;
      existing.status = 'ready';
    } else {
      spec.images.push({ id: `u_${ua.id.slice(0, 8)}`, desc: '用户上传素材', usage: '按大纲需要使用', origin: 'user', file: ua.filename, status: 'ready' });
    }
  }
  const userCount = userAssets.length;

  // 2) AI 生成图：上游 image-generator §6 manifest 模式（--manifest 批量执行是上游标准路径，
  //    同时避开单次模式长 prompt 的 argv 边界——workflow_transcript 把长参数当路径 stat 会崩）
  let aiDone = 0;
  const aiImgs = spec.images.filter((im) => im.origin !== 'user');
  const pendingImgs = aiImgs.filter((im) => im.status !== 'done' && im.status !== 'ready');
  if (pendingImgs.length) {
    const deckColors = (spec.style.palette ?? []);
    // 提示词按上游 §4 模板组装：主题 + deck 色彩行为 + text_policy 硬规则 + 容器注记
    const manifest = {
      project: taskId.replace(/-/g, '_'),
      generated_at: new Date().toISOString(),
      deck_rendering: 'editorial-illustration',
      color_scheme: {
        background: deckColors[0] ?? '#FFFFFF',
        primary: deckColors[1] ?? '#1A1A1A',
        accent: deckColors[2] ?? '#C0392B',
      },
      items: pendingImgs.map((img) => ({
        filename: `${img.id}.png`,
        purpose: img.usage,
        page_role: img.page_role ?? 'local',
        text_policy: img.text_policy ?? 'none',
        aspect_ratio: '16:9',
        prompt: [
          img.desc,
          `Deck color behavior: core deck colors ${deckColors.slice(0, 4).join(', ')} anchor the palette — background dominates the field, primary carries main forms, accents stay scarce; Color values (HEX codes) and color names are rendering guidance only — do NOT display HEX codes, color names, or palette labels as visible text anywhere in the image.`,
          (img.text_policy ?? 'none') === 'embedded'
            ? 'Stable in-figure labels are part of the artwork; authoritative deck titles stay as SVG overlay, not baked in.'
            : 'NO text of any kind anywhere in the image — no letters, numbers, signs, watermarks, labels, or written symbols.',
          `Composed as a 1536x864px image for ${img.page_role ?? 'local'} use${img.page_role === 'hero_page' ? ', reserving space for SVG overlay of the deck title' : ''}.`,
        ].join('\n'),
        alt_text: img.usage,
        status: 'Pending',
      })),
    };
    const manifestPath = join(imgDir, 'image_prompts.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    setStep(deps, taskId, 'assets', 'running', `生成配图（上游 manifest 模式，${pendingImgs.length} 张）`);
    updateTask(deps, taskId, { spec_json: JSON.stringify(spec) });
    const gen = await runPython('image_gen.py', ['--manifest', manifestPath, '--backend', 'openai'], {
      timeoutMs: 300000 * Math.max(1, Math.ceil(pendingImgs.length / 2)),
      env: {
        OPENAI_API_KEY: cfg.apiKey,
        OPENAI_BASE_URL: cfg.baseUrl,
        OPENAI_MODEL: cfg.imageModel,
        OPENAI_SIZE_PRESET: 'auto',
        OPENAI_RESPONSE_FORMAT: 'auto',
      },
    });
    // 读回 manifest 状态（image_gen 会把每项 status 写回）
    try {
      const result = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const item of result.items ?? []) {
        const img = pendingImgs.find((x) => `${x.id}.png` === item.filename);
        if (!img) continue;
        if (existsSync(join(imgDir, item.filename))) {
          img.file = item.filename;
          img.status = 'done';
        } else {
          img.status = 'failed';
          img.error = String(item.error ?? item.status ?? '生成失败').slice(0, 300);
        }
      }
    } catch (e: any) {
      logError('ORCH', `任务 ${taskId} manifest 读回失败`, e?.message);
    }
    aiDone = aiImgs.filter((x) => x.status === 'done').length;
    log('ORCH', `任务 ${taskId} manifest 生图完成 ${aiDone}/${aiImgs.length}（exit ${gen.code}）`);
  }

  const okAssets = spec.images.filter((im) => im.status === 'done' || im.status === 'ready').length;
  const parts = [`${okAssets} 张素材就绪`];
  if (userCount) parts.push(`含用户上传 ${userCount} 张`);
  const failed = aiImgs.length - aiDone;
  if (failed > 0) parts.push(`${failed} 张生成失败（跳过）`);
  setStep(deps, taskId, 'assets', 'done', parts.join('，'));
  updateTask(deps, taskId, { spec_json: JSON.stringify(spec) });
}

export function currentProgress(deps: OrchestratorDeps, taskId: string): TaskProgress {
  const t = getTask(deps, taskId);
  try {
    const p = JSON.parse(t?.progress_json || '{}');
    if (!Array.isArray(p.steps)) p.steps = initialSteps();
    return p;
  } catch {
    return { phase: 'generating', currentPage: 0, totalPages: 0, steps: initialSteps(), pages: [] };
  }
}

/** 确认后开始执行（对外入口：用户确认 或 quick 直达） */
export async function startExecution(deps: OrchestratorDeps, taskId: string, spec: DesignSpec): Promise<void> {
  if (running.has(taskId)) return;
  running.add(taskId);
  const t = getTask(deps, taskId);
  if (!t) { running.delete(taskId); return; }
  const userId = t.user_id;

  // 预扣积分：页 × 1 + 计划图片 × 1
  const quote = quoteTask(spec.pages.length, spec.images.length);
  try {
    holdCredits(deps, userId, taskId, quote.total);
  } catch (e: any) {
    updateTask(deps, taskId, { status: 'failed', error: e?.message, done_at: Date.now() });
    running.delete(taskId);
    return;
  }

  let projectPath = '';
  try {
    const cfg = getUserGatewayConfig(deps.db, userId, deps.secretKey);
    const params = JSON.parse(t.params_json || '{}');
    // project_manager 以 cwd 为基准创建 <cwd>/projects/<name>，所以 cwd 直接给 dataDir
    const projectsRoot = join(deps.dataDir, 'projects');
    mkdirSync(projectsRoot, { recursive: true });
    projectPath = await initProject(taskId.replace(/-/g, '_'), spec.format, deps.dataDir);

    // deck 模板素材（logo/装饰图）复制进项目 images/，Executor 可直接引用（内置与自定义统一走表）
    let tplAssetNames: string[] = [];
    const tid = (params.templateId || spec.templateId) as string | undefined;
    if (tid) {
      const tpl = deps.db.prepare('SELECT kind, assets_json, pages_json FROM templates WHERE id=?').get(tid) as any;
      if (tpl?.kind === 'deck' && tpl.assets_json) {
        tplAssetNames = Object.keys(JSON.parse(tpl.assets_json));
        // 素材目录：内置模板 id 含 :/ 被替换为 _（与 syncBuiltinToTemplates 一致）
        const srcDir = join(deps.dataDir, 'template-assets', tid.replace(/[:/]/g, '_'));
        const dstDir = join(projectPath, 'images');
        mkdirSync(dstDir, { recursive: true });
        // 从原型 SVG 提取每个素材的真实使用位置（x,y,w,h），生成精确的 usage 提示
        let protoPagesForAssets: string[] = [];
        try { protoPagesForAssets = JSON.parse(tpl.pages_json ?? '[]'); } catch { /* ignore */ }
        const usageOf = (fname: string): string => {
          const uses: string[] = [];
          for (const svg of protoPagesForAssets) {
            for (const m of svg.matchAll(/<image[^>]*>/g)) {
              const tag = m[0];
              if (!tag.includes(fname)) continue;
              const x = tag.match(/x="([\d.]+)"/)?.[1];
              const y = tag.match(/y="([\d.]+)"/)?.[1];
              const w = tag.match(/width="([\d.]+)"/)?.[1];
              const h = tag.match(/height="([\d.]+)"/)?.[1];
              if (x && y) uses.push(`(${x},${y}${w ? ` 尺寸${w}x${h ?? '?'}` : ''})`);
            }
          }
          return uses.length ? `模板品牌元素（${fname}），原型中的使用位置：${uses.slice(0, 4).join('、')}——生成对应页面时用 <image href="../images/tpl_${fname}" .../> 在相同位置引用` : `模板品牌元素（${fname}），按模板原型位置使用`;
        };
        let copiedCount = 0;
        for (const fname of tplAssetNames) {
          const sf = join(srcDir, fname);
          if (existsSync(sf)) {
            copyFileSync(sf, join(dstDir, `tpl_${fname}`));
            spec.images.push({
              id: `tpl_${fname}`, desc: '模板素材（logo/装饰）', usage: usageOf(fname),
              origin: 'user', file: `tpl_${fname}`, status: 'ready',
            });
            copiedCount++;
          }
        }
        log('ORCH', `任务 ${taskId} 模板素材复制 ${copiedCount}/${tplAssetNames.length}（${tid}）`);
      }
    }
    const projectDir = basename(projectPath);
    log('ORCH', `任务 ${taskId} 项目目录: ${projectPath}`);
    setProgress(deps, taskId, { ...currentProgress(deps, taskId), projectDir });

    // 1) 素材（用户上传复制 + AI 生成）
    const hasAssets = (Array.isArray(params.assetIds) && params.assetIds.length) || spec.images.some((im) => im.origin !== 'user');
    if (hasAssets) {
      await prepareAssets(deps, taskId, cfg, spec, projectPath, params);
    } else {
      setStep(deps, taskId, 'assets', 'skipped', '无配图素材');
    }

    // 2) 逐页生成 + 质检回环
    const svgDir = join(projectPath, 'svg_output');
    mkdirSync(svgDir, { recursive: true });
    const total = spec.pages.length;
    const pagesProgress: PageProgress[] = spec.pages.map((p) => ({ id: p.id, title: p.title, role: p.role, status: 'pending' }));
    const prevSummaries: string[] = [];
    setStep(deps, taskId, 'pages', 'running', `0/${total} 页`);

    for (let i = 0; i < total; i++) {
      const page = spec.pages[i];
      const pageNum = i + 1;
      pagesProgress[i].status = 'generating';
      pagesProgress[i].attempts = [];
      setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'generating', currentPage: pageNum, totalPages: total, pages: pagesProgress });
      setStep(deps, taskId, 'pages', 'running', `第 ${pageNum}/${total} 页：${page.title}`);

      const svgFile = join(svgDir, `slide_${String(pageNum).padStart(2, '0')}.svg`);
      let ok = false;
      let lastErr = '';
      // 上游 quick-generate 契约：逐页生成中不跑 checker（gate 只在 early/final 点）；
      // 此处仅对生成本身做基础设施级重试（网络/解析异常）
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const svg = await generatePageSvg(cfg, spec, page, pageNum, total, prevSummaries, attempt > 0 ? lastErr : undefined);
          writeFileSync(svgFile, svg);
          ok = true;
          if (attempt > 0) {
            pagesProgress[i].retries = attempt;
            pagesProgress[i].attempts!.push(`第 ${attempt + 1} 次尝试成功`);
          }
        } catch (e: any) {
          lastErr = String(e?.message ?? e);
          pagesProgress[i].attempts!.push(`第 ${attempt + 1} 次生成异常：${lastErr.slice(0, 200)}`);
          logError('ORCH', `任务 ${taskId} 第 ${pageNum} 页生成异常`, lastErr);
          pagesProgress[i].retries = attempt + 1;
        }
      }
      // 上游 early gate：7+ 页时 P05 后、P06 前跑 --stage early 并一轮修复
      if (total >= 7 && pageNum === 5) {
        setStep(deps, taskId, 'pages', 'running', '早期质量门（P05 后 early gate，上游契约）…');
        const earlyCheck = await qualityCheck(projectPath, 'early');
        if (!earlyCheck.ok) {
          log('ORCH', `任务 ${taskId} early gate 发现错误，修复一轮`);
          setStep(deps, taskId, 'pages', 'running', 'early gate 发现问题，修复一轮…');
          await repairRound(deps, taskId, cfg, spec, svgDir, pagesProgress, earlyCheck);
          const recheck = await qualityCheck(projectPath, 'early');
          if (!recheck.ok) log('ORCH', `任务 ${taskId} early gate 修复后仍有问题（final gate 处理）`);
        }
      }
      if (!ok && existsSync(svgFile) === false) {
        pagesProgress[i].status = 'failed';
        pagesProgress[i].error = lastErr;
        setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'generating', currentPage: pageNum, totalPages: total, pages: pagesProgress, message: `第 ${pageNum} 页失败：${lastErr}` });
        continue; // 失败页跳过，继续后续页
      }
      if (existsSync(svgFile)) {
        pagesProgress[i].status = 'ok';
        pagesProgress[i].error = undefined;
        prevSummaries.push(`第${pageNum}页「${page.title}」：${svgSummary(readFileSync(svgFile, 'utf8'))}`);
      }
      setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'generating', currentPage: pageNum, totalPages: total, pages: pagesProgress });
    }

    const okPages = pagesProgress.filter((p) => p.status === 'ok').length;
    if (okPages === 0) {
      setStep(deps, taskId, 'pages', 'failed', '全部页面失败');
      throw new Error('所有页面生成失败');
    }
    setStep(deps, taskId, 'pages', 'done', `${okPages}/${total} 页完成${total - okPages ? `，${total - okPages} 页失败` : ''}`);

    // 3) 终检（上游契约：--quick-generate --canonical-authoring --stage final），失败则带错误修复并复检，最多 2 轮
    setStep(deps, taskId, 'inspect', 'running', '质量终检（canonical-authoring）…');
    let finalCheck = await qualityCheck(projectPath, 'final');
    let inspectLog: string[] = [];
    for (let round = 0; round < 2 && !finalCheck.ok; round++) {
      const issues = summarizeCheckErrors(finalCheck).slice(0, 300);
      inspectLog.push(`第 ${round + 1} 轮终检发现 ${countCheckErrors(finalCheck)} 个错误：${issues}`);
      log('ORCH', `任务 ${taskId} 终检未通过（第 ${round + 1} 轮修复）`);
      setStep(deps, taskId, 'inspect', 'running', `终检发现 ${countCheckErrors(finalCheck)} 个错误，第 ${round + 1} 轮修复…（详情见质检面板）`);
      const repaired = await repairRound(deps, taskId, cfg, spec, svgDir, pagesProgress, finalCheck);
      inspectLog.push(`修复了 ${repaired} 页，复检…`);
      finalCheck = await qualityCheck(projectPath, 'final');
    }
    if (!finalCheck.ok) {
      setStep(deps, taskId, 'inspect', 'failed', summarizeCheckErrors(finalCheck).slice(0, 200));
      throw new Error(`终检未通过：${summarizeCheckErrors(finalCheck).slice(0, 500)}`);
    }
    inspectLog.push('全部通过');
    // 把终检详情挂在 inspect 步骤的 detail 里（前端展开显示）
    {
      const p = currentProgress(deps, taskId);
      const st = p.steps.find((x) => x.key === 'inspect');
      if (st) (st as any).detail = inspectLog;
      setProgress(deps, taskId, p);
    }
    setStep(deps, taskId, 'inspect', 'done', inspectLog.length > 1 ? `通过（经历 ${inspectLog.length - 1} 轮修复）` : '一次通过');

    // 4) 导出 PPTX
    setStep(deps, taskId, 'export', 'running', '导出 PPTX…');
    const exportRes = await runPython('svg_to_pptx.py', [projectPath, '--quick-generate'], { timeoutMs: 600000 });
    if (exportRes.code !== 0) {
      setStep(deps, taskId, 'export', 'failed', exportRes.stderr.slice(-200));
      throw new Error(`PPTX 导出失败: ${exportRes.stderr.slice(-500) || exportRes.stdout.slice(-500)}`);
    }
    const exportsDir = join(projectPath, 'exports');
    const pptxFiles = existsSync(exportsDir) ? readdirSync(exportsDir).filter((f) => f.endsWith('.pptx')).sort() : [];
    if (!pptxFiles.length) throw new Error('导出目录中没有 pptx 文件');
    const resultPath = join(exportsDir, pptxFiles[pptxFiles.length - 1]);

    // 5) 结算：实际页数 × 1 + 成功 AI 图片 × 1（用户上传素材不收费）
    const doneImages = spec.images.filter((im) => im.origin !== 'user' && im.status === 'done').length;
    settleCredits(deps, userId, taskId, okPages * CREDITS_PER_PAGE + doneImages * CREDITS_PER_IMAGE);

    updateTask(deps, taskId, {
      status: 'done',
      result_path: resultPath,
      done_at: Date.now(),
      error: pagesProgress.some((p) => p.status === 'failed') ? `有 ${total - okPages} 页生成失败` : null,
    });
    setStep(deps, taskId, 'export', 'done', basename(resultPath));
    setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'done', currentPage: total, totalPages: total, pages: pagesProgress, message: '完成' });
    log('ORCH', `任务 ${taskId} 完成: ${resultPath}`);
  } catch (e: any) {
    logError('ORCH', `任务 ${taskId} 执行失败`, e?.stack ?? e?.message ?? String(e));
    const t2 = getTask(deps, taskId);
    // 全额退还剩余预扣
    if (t2?.credits_held) refundCredits(deps, userId, taskId, t2.credits_held, '任务失败退还');
    updateTask(deps, taskId, { status: 'failed', error: String(e?.message ?? e).slice(0, 1000), done_at: Date.now() });
    setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'failed', message: String(e?.message ?? e).slice(0, 300) });
  } finally {
    running.delete(taskId);
  }
}

export function summarizeCheckErrors(check: { ok: boolean; report: any; raw: string }): string {
  const out: string[] = [];
  // 结构化报告：files[].errors[]
  if (Array.isArray(check.report?.files)) {
    for (const f of check.report.files) {
      if (Array.isArray(f.errors) && f.errors.length) {
        out.push(`[${f.file}]`);
        for (const e of f.errors.slice(0, 10)) out.push(typeof e === 'string' ? e : JSON.stringify(e));
      }
    }
  }
  if (Array.isArray(check.report?.project_issues)) {
    for (const e of check.report.project_issues.slice(0, 5)) out.push(typeof e === 'string' ? e : JSON.stringify(e));
  }
  if (out.length) return out.join('\n').slice(0, 3000);
  return check.raw.slice(0, 1500);
}

/** 终检失败的修复轮：把错误报告喂回 LLM 重写对应页 */
async function repairRound(
  deps: OrchestratorDeps,
  taskId: string,
  cfg: GatewayConfig,
  spec: DesignSpec,
  svgDir: string,
  pagesProgress: PageProgress[],
  finalCheck: { ok: boolean; report: any; raw: string },
): Promise<number> {
  // 找出终检报错的页（结构化报告优先，回退原始输出）
  const failingFiles = new Set<string>();
  if (Array.isArray(finalCheck.report?.files)) {
    for (const f of finalCheck.report.files) {
      if (Array.isArray(f.errors) && f.errors.length) failingFiles.add(String(f.file));
    }
  } else {
    for (let i = 0; i < pagesProgress.length; i++) {
      const f = `slide_${String(i + 1).padStart(2, '0')}`;
      if (finalCheck.raw.includes(f)) failingFiles.add(`${f}.svg`);
    }
  }
  let repairedCount = 0;
  for (let i = 0; i < pagesProgress.length; i++) {
    const p = pagesProgress[i];
    if (p.status !== 'ok') continue;
    const file = `slide_${String(i + 1).padStart(2, '0')}.svg`;
    if (!failingFiles.has(file)) continue;
    try {
      const cur = readFileSync(join(svgDir, file), 'utf8');
      const out = await chatCompletion(cfg, [
        { role: 'system', content: executorSystemPrompt() },
        {
          role: 'user',
          content: `以下这页 SVG 未通过质量检查。请修复所有错误后输出完整修正版 SVG（只输出 SVG）。\n\n=== 质检报告 ===\n${summarizeCheckErrors(finalCheck)}\n\n=== 原 SVG ===\n${cur}`,
        },
      ], { maxTokens: 16384, temperature: 0.4 });
      writeFileSync(join(svgDir, file), extractSvg(out));
      p.retries = (p.retries ?? 0) + 1;
      p.attempts = [...(p.attempts ?? []), `终检修复轮：根据质检报告重写了本页`];
      repairedCount++;
    } catch (e: any) {
      logError('ORCH', `任务 ${taskId} 修复 ${file} 失败`, e?.message);
    }
  }
  return repairedCount;
}

/** 统计质检报告中的错误条数 */
function countCheckErrors(check: { ok: boolean; report: any; raw: string }): number {
  let n = 0;
  if (Array.isArray(check.report?.files)) {
    for (const f of check.report.files) n += Array.isArray(f.errors) ? f.errors.length : 0;
  }
  return n || (check.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

export function createTask(
  deps: OrchestratorDeps,
  userId: string,
  input: { mode: TaskMode; topic?: string; sourceText?: string; pages?: number; format?: string; styleHint?: string; audience?: string; language?: string; templateId?: string | null; assetIds?: string[]; research?: boolean; instruction?: string; name?: string; description?: string; fileId?: string; fileIds?: string[]; imageMode?: string; templateKind?: string },
): string {
  const id = randomUUID();
  const pages = Number(input.pages) > 0 ? Number(input.pages) : 0; // 0 = AI 决定
  deps.db
    .prepare(
      `INSERT INTO tasks(id, user_id, mode, status, topic, source_text, params_json, progress_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id, userId, input.mode, 'planning',
      input.topic ?? '', input.sourceText ?? '',
      JSON.stringify({
        pages, format: input.format ?? 'ppt169', styleHint: input.styleHint ?? '',
        audience: input.audience ?? '', language: input.language ?? '',
        templateId: input.templateId ?? null, assetIds: input.assetIds ?? [],
        research: input.research ?? false, imageMode: input.imageMode ?? 'auto', templateKind: input.templateKind ?? 'style',
        instruction: input.instruction ?? '', name: input.name ?? '', description: input.description ?? '',
        fileId: input.fileId ?? null, fileIds: input.fileIds ?? [],
      }),
      JSON.stringify({ phase: 'planning', currentPage: 0, totalPages: pages, steps: initialSteps(), pages: [], message: '正在规划大纲…' }),
      Date.now()
    );
  // 异步规划（仅生成类模式；beautify/edit_native/create_template/image_to_pptx 由路由层直接分发执行流程）
  if (input.mode === 'generate' || input.mode === 'quick') {
    void planTask(deps, id);
  }
  return id;
}

export function confirmTask(deps: OrchestratorDeps, taskId: string, userId: string, editedSpec?: DesignSpec): { error?: string } {
  const t = getTask(deps, taskId);
  if (!t || t.user_id !== userId) return { error: '任务不存在' };
  if (t.status !== 'awaiting_confirm') return { error: '任务不在待确认状态' };
  const spec = editedSpec ?? (t.spec_json ? JSON.parse(t.spec_json) : null);
  if (!spec || !Array.isArray(spec.pages)) return { error: '无效的规格' };
  updateTask(deps, taskId, { spec_json: JSON.stringify(spec), status: 'generating' });
  void startExecution(deps, taskId, spec);
  return {};
}

export function cancelTask(deps: OrchestratorDeps, taskId: string, userId: string): { error?: string } {
  const t = getTask(deps, taskId);
  if (!t || (t.user_id !== userId && userId !== 'admin')) return { error: '任务不存在' };
  if (['done', 'failed', 'cancelled'].includes(t.status)) return { error: '任务已结束' };
  if (t.credits_held) refundCredits(deps, t.user_id, taskId, t.credits_held, '任务取消退还');
  updateTask(deps, taskId, { status: 'cancelled', done_at: Date.now() });
  // running 中的编排循环会在下一个检查点看到 status=cancelled 而退出（简化：当前实现靠进程内 promise 自然结束，此处仅退款）
  return {};
}
