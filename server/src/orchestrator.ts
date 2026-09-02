import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Db } from './db.js';
import { getUserGatewayConfig, chatCompletion, generateImage, type GatewayConfig, type ChatMessage } from './gateway.js';
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
  { id: 'beautify', name: '美化 PPT', desc: '上传 PPTX，保持页数/顺序/措辞重排视觉', ready: false },
  { id: 'edit_native', name: '编辑 PPT', desc: '上传 PPTX，保留原设计只改内容', ready: false },
  { id: 'create_template', name: '创建模板', desc: '从参考稿蒸馏品牌/风格/版式模板', ready: false },
  { id: 'image_to_pptx', name: '图片转 PPT', desc: '页面截图重建为可编辑 PPT', ready: false },
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
  status: 'pending' | 'generating' | 'done' | 'failed';
  file?: string;
  error?: string;
}

export interface DesignSpec {
  title: string;
  format: string;
  pages: PageSpec[];
  images: ImageSpec[];
  style: {
    mode: string;
    palette: string[];
    typography: string;
    notes: string;
  };
}

interface PageProgress {
  id: string;
  title: string;
  status: 'pending' | 'generating' | 'ok' | 'failed';
  error?: string;
  retries?: number;
}

export interface TaskProgress {
  phase: string;
  currentPage: number;
  totalPages: number;
  pages: PageProgress[];
  message?: string;
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

interface TaskRow {
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

function getTask(deps: OrchestratorDeps, id: string): TaskRow | undefined {
  return deps.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow | undefined;
}

function updateTask(deps: OrchestratorDeps, id: string, patch: Partial<TaskRow>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const setSql = keys.map((k) => `${k}=?`).join(', ');
  deps.db.prepare(`UPDATE tasks SET ${setSql} WHERE id=?`).run(...keys.map((k) => (patch as any)[k]), id);
}

function setProgress(deps: OrchestratorDeps, id: string, progress: TaskProgress): void {
  updateTask(deps, id, { progress_json: JSON.stringify(progress) });
}

// ---------------------------------------------------------------------------
// 积分：预扣 / 结算 / 退回
// ---------------------------------------------------------------------------

function holdCredits(deps: OrchestratorDeps, userId: string, taskId: string, amount: number): void {
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

function refundCredits(deps: OrchestratorDeps, userId: string, taskId: string, amount: number, reason: string): void {
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

function settleCredits(deps: OrchestratorDeps, userId: string, taskId: string, actual: number): void {
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
function extractSvg(text: string): string {
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
    { "id": "img01", "desc": "生成这张图的英文提示词，具体、有画面感", "usage": "p01 封面全幅背景 hero 图" }
  ]
}

规则：
- pages 数量必须等于用户要求的页数；第一页 role=cover，最后一页 role=closing，中间按内容逻辑安排 toc/section/content/data。
- outline 要写得足以让另一位设计执行者在没有上下文的情况下完成该页：包含该页的论点、数据、层级结构。
- images 每页至多 1 张，全篇 0-4 张；只在真正提升表达时使用（封面 hero、关键场景图）。不需要图片就给空数组。
- palette 给 3-5 个协调的六位十六进制色（大写 #RRGGBB），含背景/主文字/强调色。
- 若用户给了源材料，内容必须忠于材料事实，不得编造数据。`;

export async function planTask(deps: OrchestratorDeps, taskId: string): Promise<void> {
  const t = getTask(deps, taskId);
  if (!t) return;
  const cfg = getUserGatewayConfig(deps.db, t.user_id, deps.secretKey);
  const params = JSON.parse(t.params_json || '{}');

  setProgress(deps, taskId, { phase: 'planning', currentPage: 0, totalPages: params.pages ?? 8, pages: [], message: '正在规划大纲…' });

  const userMsg = [
    `主题：${t.topic || '（见源材料）'}`,
    t.source_text ? `\n源材料：\n${t.source_text.slice(0, 60000)}` : '',
    `\n要求：${params.pages ?? 8} 页，格式 ${params.format ?? 'ppt169'}，风格偏好：${params.styleHint || '自由发挥'}`,
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
    spec.images = Array.isArray(spec.images) ? spec.images.map((im, i) => ({ ...im, id: im.id || `img${String(i + 1).padStart(2, '0')}`, status: 'pending' })) : [];

    // mode=quick：跳过用户确认直接执行
    if (t.mode === 'quick') {
      updateTask(deps, taskId, { spec_json: JSON.stringify(spec), status: 'generating' });
      await startExecution(deps, taskId, spec);
    } else {
      updateTask(deps, taskId, { spec_json: JSON.stringify(spec), status: 'awaiting_confirm' });
      setProgress(deps, taskId, { phase: 'awaiting_confirm', currentPage: 0, totalPages: spec.pages.length, pages: [], message: '大纲已就绪，等待确认' });
    }
  } catch (e: any) {
    logError('ORCH', `任务 ${taskId} 规划失败`, e?.message);
    updateTask(deps, taskId, { status: 'failed', error: `规划失败：${e?.message ?? e}`, done_at: Date.now() });
    setProgress(deps, taskId, { phase: 'failed', currentPage: 0, totalPages: 0, pages: [], message: String(e?.message ?? e) });
  }
}

// ---------------------------------------------------------------------------
// 阶段 2：执行（Executor 蒸馏：逐页 SVG → 质检回环 → 导出）
// ---------------------------------------------------------------------------

const EXECUTOR_SYSTEM_CACHE = { content: '' };
function executorSystemPrompt(): string {
  if (!EXECUTOR_SYSTEM_CACHE.content) {
    EXECUTOR_SYSTEM_CACHE.content = [
      '你是一位顶级信息设计执行者（Executor）。你按照项目规范逐页手写 SVG。以下是必须严格遵守的技术规范文档：',
      '',
      '=== 核心规范（shared-standards-core.md）===',
      loadRef('shared-standards-core.md'),
      '',
      '=== 效果与几何规范（svg-effects.md）===',
      loadRef('svg-effects.md'),
      '',
      '=== 执行者工作手册（executor-base.md）===',
      loadRef('executor-base.md'),
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
      ? `可用图片资源（用 <image href="../images/文件名" .../> 引用，遵守 image 规范的 preserveAspectRatio 裁切约定）：${JSON.stringify(spec.images.filter((i) => i.status === 'done').map((i) => ({ file: i.file, usage: i.usage })))}`
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

async function generateAllImages(deps: OrchestratorDeps, taskId: string, cfg: GatewayConfig, spec: DesignSpec, projectPath: string): Promise<void> {
  const imgDir = join(projectPath, 'images');
  mkdirSync(imgDir, { recursive: true });
  for (const img of spec.images) {
    if (img.status === 'done') continue;
    img.status = 'generating';
    setProgress(deps, taskId, { ...currentProgress(deps, taskId), message: `正在生成图片：${img.usage}` });
    try {
      const b64 = await generateImage(cfg, img.desc, { size: '1536x864' });
      const file = `${img.id}.png`;
      writeFileSync(join(imgDir, file), Buffer.from(b64, 'base64'));
      img.file = file;
      img.status = 'done';
      log('ORCH', `任务 ${taskId} 图片 ${img.id} 生成成功`);
    } catch (e: any) {
      img.status = 'failed';
      img.error = String(e?.message ?? e);
      logError('ORCH', `任务 ${taskId} 图片 ${img.id} 生成失败`, img.error);
      // 图片失败不阻断流程，SVG 阶段会拿不到该资源从而使用占位/纯排版方案
    }
  }
}

function currentProgress(deps: OrchestratorDeps, taskId: string): TaskProgress {
  const t = getTask(deps, taskId);
  try {
    return JSON.parse(t?.progress_json || '{}');
  } catch {
    return { phase: 'generating', currentPage: 0, totalPages: 0, pages: [] };
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
    // project_manager 以 cwd 为基准创建 <cwd>/projects/<name>，所以 cwd 直接给 dataDir
    const projectsRoot = join(deps.dataDir, 'projects');
    mkdirSync(projectsRoot, { recursive: true });
    projectPath = await initProject(taskId.replace(/-/g, '_'), spec.format, deps.dataDir);
    log('ORCH', `任务 ${taskId} 项目目录: ${projectPath}`);

    // 1) 图片资源
    if (spec.images.length) {
      await generateAllImages(deps, taskId, cfg, spec, projectPath);
      updateTask(deps, taskId, { spec_json: JSON.stringify(spec) });
    }

    // 2) 逐页生成 + 质检回环
    const svgDir = join(projectPath, 'svg_output');
    mkdirSync(svgDir, { recursive: true });
    const total = spec.pages.length;
    const pagesProgress: PageProgress[] = spec.pages.map((p) => ({ id: p.id, title: p.title, status: 'pending' }));
    const prevSummaries: string[] = [];

    for (let i = 0; i < total; i++) {
      const page = spec.pages[i];
      const pageNum = i + 1;
      pagesProgress[i].status = 'generating';
      setProgress(deps, taskId, { phase: 'generating', currentPage: pageNum, totalPages: total, pages: pagesProgress });

      const svgFile = join(svgDir, `slide_${String(pageNum).padStart(2, '0')}.svg`);
      let ok = false;
      let lastErr = '';
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const svg = await generatePageSvg(cfg, spec, page, pageNum, total, prevSummaries, attempt > 0 ? lastErr : undefined);
          writeFileSync(svgFile, svg);
          // 单页即时质检（page 阶段，quick-generate 契约）
          const check = await qualityCheck(projectPath, 'page', `slide_${String(pageNum).padStart(2, '0')}.svg`);
          if (check.ok) {
            ok = true;
          } else {
            lastErr = summarizeCheckErrors(check);
            log('ORCH', `任务 ${taskId} 第 ${pageNum} 页质检未过（第 ${attempt + 1} 次）：${lastErr.slice(0, 200)}`);
            pagesProgress[i].retries = attempt + 1;
          }
        } catch (e: any) {
          lastErr = String(e?.message ?? e);
          logError('ORCH', `任务 ${taskId} 第 ${pageNum} 页生成异常`, lastErr);
        }
      }
      if (!ok && existsSync(svgFile) === false) {
        pagesProgress[i].status = 'failed';
        pagesProgress[i].error = lastErr;
        setProgress(deps, taskId, { phase: 'generating', currentPage: pageNum, totalPages: total, pages: pagesProgress, message: `第 ${pageNum} 页失败：${lastErr}` });
        continue; // 失败页跳过，继续后续页
      }
      if (existsSync(svgFile)) {
        pagesProgress[i].status = 'ok';
        prevSummaries.push(`第${pageNum}页「${page.title}」：${svgSummary(readFileSync(svgFile, 'utf8'))}`);
      }
      setProgress(deps, taskId, { phase: 'generating', currentPage: pageNum, totalPages: total, pages: pagesProgress });
    }

    const okPages = pagesProgress.filter((p) => p.status === 'ok').length;
    if (okPages === 0) throw new Error('所有页面生成失败');

    // 3) 终检（quick-generate 契约：--stage final 必须过），失败则带错误修复并复检，最多 2 轮
    setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'exporting', message: '最终质检…' });
    let finalCheck = await qualityCheck(projectPath, 'final');
    for (let round = 0; round < 2 && !finalCheck.ok; round++) {
      log('ORCH', `任务 ${taskId} 终检未通过（第 ${round + 1} 轮修复）`);
      await repairRound(deps, taskId, cfg, spec, svgDir, pagesProgress, finalCheck);
      finalCheck = await qualityCheck(projectPath, 'final');
    }
    if (!finalCheck.ok) {
      throw new Error(`终检未通过：${summarizeCheckErrors(finalCheck).slice(0, 500)}`);
    }

    // 4) 导出 PPTX
    setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'exporting', message: '正在导出 PPTX…' });
    const exportRes = await runPython('svg_to_pptx.py', [projectPath, '--quick-generate'], { timeoutMs: 600000 });
    if (exportRes.code !== 0) {
      throw new Error(`PPTX 导出失败: ${exportRes.stderr.slice(-500) || exportRes.stdout.slice(-500)}`);
    }
    const exportsDir = join(projectPath, 'exports');
    const pptxFiles = existsSync(exportsDir) ? readdirSync(exportsDir).filter((f) => f.endsWith('.pptx')).sort() : [];
    if (!pptxFiles.length) throw new Error('导出目录中没有 pptx 文件');
    const resultPath = join(exportsDir, pptxFiles[pptxFiles.length - 1]);

    // 5) 结算：实际页数 × 1 + 成功图片 × 1
    const doneImages = spec.images.filter((im) => im.status === 'done').length;
    settleCredits(deps, userId, taskId, okPages * CREDITS_PER_PAGE + doneImages * CREDITS_PER_IMAGE);

    updateTask(deps, taskId, {
      status: 'done',
      result_path: resultPath,
      done_at: Date.now(),
      error: pagesProgress.some((p) => p.status === 'failed') ? `有 ${total - okPages} 页生成失败` : null,
    });
    setProgress(deps, taskId, { phase: 'done', currentPage: total, totalPages: total, pages: pagesProgress, message: '完成' });
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

function summarizeCheckErrors(check: { ok: boolean; report: any; raw: string }): string {
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
): Promise<void> {
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
    } catch (e: any) {
      logError('ORCH', `任务 ${taskId} 修复 ${file} 失败`, e?.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

export function createTask(
  deps: OrchestratorDeps,
  userId: string,
  input: { mode: TaskMode; topic?: string; sourceText?: string; pages?: number; format?: string; styleHint?: string; audience?: string; language?: string },
): string {
  const id = randomUUID();
  deps.db
    .prepare(
      `INSERT INTO tasks(id, user_id, mode, status, topic, source_text, params_json, progress_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id, userId, input.mode, 'planning',
      input.topic ?? '', input.sourceText ?? '',
      JSON.stringify({ pages: input.pages ?? 8, format: input.format ?? 'ppt169', styleHint: input.styleHint ?? '', audience: input.language ?? '', language: input.language ?? '' }),
      JSON.stringify({ phase: 'planning', currentPage: 0, totalPages: input.pages ?? 8, pages: [] }),
      Date.now()
    );
  // 异步规划，不阻塞响应
  void planTask(deps, id);
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
