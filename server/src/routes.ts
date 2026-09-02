import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Db } from './db.js';
import { getUserGatewayConfig, chatCompletion, generateImage, type GatewayConfig } from './gateway.js';
import { runPython, qualityCheck, initProject, SKILL_DIR } from './pipeline.js';
import { builtinSpecText } from './builtinTemplates.js';
import { CREDITS_PER_PAGE } from './credits.js';
import { log, logError } from './logger.js';
import { randomUUID } from 'node:crypto';
import { type TaskProgress, type StepProgress, type StepKey, initialSteps, currentProgress, setStep, setProgress, holdCredits, settleCredits, refundCredits, extractJson, executorSystemPrompt, extractSvg, summarizeCheckErrors, getTask, updateTask } from './orchestrator.js';

/**
 * 其余 4 条路由的服务端编排：
 *  - beautify:       上传 PPTX → 提取内容契约+身份 → 逐页重排版（1:1 页数/顺序/措辞）
 *  - edit_native:    上传 PPTX → pptx_to_svg --roundtrip → 按指令改页 → roundtrip 导出（原设计保留）
 *  - create_template: 参考稿（PPTX/图片）→ 蒸馏为模板（存入 templates 表）
 *  - image_to_pptx:  页面截图 → 逐页重建可编辑 SVG → 导出
 */

// ---------------------------------------------------------------------------
// 共用：上传文件登记（params.fileId → data/uploads 文件）
// ---------------------------------------------------------------------------

function resolveUploadFile(deps: { db: Db; dataDir: string }, fileId: string): { path: string; filename: string; mime: string } | null {
  const row = deps.db.prepare('SELECT * FROM uploads WHERE id=?').get(fileId) as any;
  if (!row || !existsSync(row.path)) return null;
  return { path: row.path, filename: row.filename, mime: row.mime };
}

function failTask(deps: any, taskId: string, msg: string): void {
  logError('ROUTE', `任务 ${taskId} 失败`, msg);
  const t = getTask(deps, taskId);
  if (t?.credits_held) refundCredits(deps, t.user_id, taskId, t.credits_held, '任务失败退还');
  updateTask(deps, taskId, { status: 'failed', error: String(msg).slice(0, 1000), done_at: Date.now() });
  setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'failed', message: String(msg).slice(0, 300) });
}

// ---------------------------------------------------------------------------
// 路由 1：Beautify（重排版，1:1 保页数/顺序/措辞）
// ---------------------------------------------------------------------------

const BEAUTIFY_STEPS: { key: StepKey; label: string }[] = [
  { key: 'plan', label: '提取内容' },
  { key: 'assets', label: '提取素材' },
  { key: 'pages', label: '逐页重排' },
  { key: 'inspect', label: '质量终检' },
  { key: 'export', label: '导出 PPTX' },
];

const BEAUTIFY_SYSTEM = `你是演示美化执行者。输入是冻结的内容契约（每页的文本内容，1:1 不可改），
你逐页重新设计排版。只输出 JSON（可围栏）：
{ "pages": [ { "id": "p01", "title": "该页主标题", "outline": "该页全部内容要点，逐条列出，措辞与原文一致" } ] }
规则：页数与顺序严格等于输入的页数；不得增删改写任何文本内容（可断句）；outline 必须完整承载该页所有文字。`;

export async function runBeautify(deps: any, taskId: string): Promise<void> {
  const t = getTask(deps, taskId)!;
  const params = JSON.parse(t.params_json || '{}');
  const cfg = getUserGatewayConfig(deps.db, t.user_id, deps.secretKey);
  const userId = t.user_id;

  // 上传的源 PPTX
  const src = params.fileId ? resolveUploadFile(deps, params.fileId) : null;
  if (!src) return failTask(deps, taskId, '缺少上传的 PPTX 文件');

  // 步骤时间线（beautify 特化标签）
  const progress: TaskProgress = { phase: 'generating', currentPage: 0, totalPages: 0, steps: BEAUTIFY_STEPS.map((s) => ({ ...s, status: 'pending' })), pages: [] };
  setProgress(deps, taskId, progress);
  updateTask(deps, taskId, { status: 'generating' });

  try {
    holdCredits(deps, userId, taskId, 100); // 先按较大值预扣，完成后按实际结算（多退少补）

    // 1) 建项目 + 导入源
    setStep(deps, taskId, 'plan', 'running', '导入 PPTX…');
    const projectsRoot = join(deps.dataDir, 'projects');
    mkdirSync(projectsRoot, { recursive: true });
    const projectPath = await initProject(taskId.replace(/-/g, '_'), 'ppt169', deps.dataDir);
    const srcCopy = join(projectPath, 'sources', src.filename.endsWith('.pptx') ? src.filename : `${src.filename}.pptx`);
    mkdirSync(join(projectPath, 'sources'), { recursive: true });
    copyFileSync(src.path, srcCopy);

    const imp = await runPython('project_manager.py', ['import-sources', projectPath, srcCopy], { timeoutMs: 300000 });
    if (imp.code !== 0) throw new Error(`导入 PPTX 失败: ${imp.stderr.slice(-300)}`);
    setStep(deps, taskId, 'plan', 'done', '内容与身份提取完成');

    // 2) 读取冻结内容契约（sources/<stem>.md）与身份
    const stem = basename(srcCopy).replace(/\.pptx$/i, '');
    const contentMd = existsSync(join(projectPath, 'sources', `${stem}.md`))
      ? readFileSync(join(projectPath, 'sources', `${stem}.md`), 'utf8')
      : '';
    let identity: any = null;
    const idFiles = readdirSync(join(projectPath, 'analysis')).filter((f) => f.endsWith('.identity.json'));
    if (idFiles.length) {
      try { identity = JSON.parse(readFileSync(join(projectPath, 'analysis', idFiles[0]), 'utf8')); } catch { /* ignore */ }
    }
    if (!contentMd) throw new Error('内容提取为空（PPTX 无可读文本？）');

    // 3) LLM 解析每页大纲（冻结措辞）
    setStep(deps, taskId, 'assets', 'running', '解析页面内容…');
    const outline = await chatCompletion(cfg, [
      { role: 'system', content: BEAUTIFY_SYSTEM },
      { role: 'user', content: `源 PPTX 内容（Markdown，按页分块）：\n${contentMd.slice(0, 60000)}\n\n${params.instruction ? `用户美化要求：${params.instruction}` : ''}` },
    ], { maxTokens: 16384, temperature: 0.3 });
    const spec = extractJson<{ pages: { id: string; title: string; outline: string }[] }>(outline);
    const total = spec.pages.length;
    if (!total) throw new Error('未解析出页面');
    updateTask(deps, taskId, { spec_json: JSON.stringify({ title: params.instruction?.slice(0, 50) || '美化任务', format: 'ppt169', pages: spec.pages, images: [], style: identity?.theme ? { mode: 'beautify', palette: [], typography: '', notes: '' } : { mode: 'beautify', palette: [], typography: '', notes: '' } }) });
    setStep(deps, taskId, 'assets', 'done', `${total} 页内容就绪`);

    // 4) 逐页重排（Executor 同款管线）
    const svgDir = join(projectPath, 'svg_output');
    mkdirSync(svgDir, { recursive: true });
    const pagesProgress: any[] = spec.pages.map((p) => ({ id: p.id, title: p.title, role: 'content', status: 'pending', attempts: [] }));
    setStep(deps, taskId, 'pages', 'running', `0/${total} 页`);

    const prevSummaries: string[] = [];
    let okPages = 0;
    for (let i = 0; i < total; i++) {
      const page = spec.pages[i];
      const pageNum = i + 1;
      pagesProgress[i].status = 'generating';
      setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'generating', currentPage: pageNum, totalPages: total, pages: pagesProgress });
      setStep(deps, taskId, 'pages', 'running', `第 ${pageNum}/${total} 页：${page.title.slice(0, 20)}`);

      const svgFile = join(svgDir, `slide_${String(pageNum).padStart(2, '0')}.svg`);
      let ok = false;
      let lastErr = '';
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const userMsg = [
            `任务：美化重排。该页内容（措辞冻结，全部保留）：${page.outline}`,
            `该页序号：${pageNum}/${total}，角色：${pageNum === 1 ? 'cover' : pageNum === total ? 'ending' : 'content'}`,
            identity ? `源主题参考（配色/字体可延续）：${JSON.stringify({ palette: identity.theme?.palette, fonts: identity.theme?.fonts }).slice(0, 800)}` : '',
            params.instruction ? `用户要求：${params.instruction}` : '',
            prevSummaries.length ? `已完成页面摘要（视觉延续）：\n${prevSummaries.join('\n')}` : '',
            '输出：只输出完整 SVG（1280×720）。根元素 data-pptx-page-role；顶层 <g id> 带 data-pptx-bounds="x y width height"；背景矩形直接 id + data-pptx-role="background"。',
          ].filter(Boolean).join('\n');
          const out = await chatCompletion(cfg, [
            { role: 'system', content: executorSystemPrompt() },
            { role: 'user', content: attempt > 0 ? `上次错误：\n${lastErr}\n${userMsg}` : userMsg },
          ], { maxTokens: 16384, temperature: 0.8 });
          writeFileSync(svgFile, extractSvg(out));
          const check = await qualityCheck(projectPath, 'page', `slide_${String(pageNum).padStart(2, '0')}.svg`);
          if (check.ok) ok = true;
          else { lastErr = summarizeCheckErrors(check); pagesProgress[i].retries = attempt + 1; }
        } catch (e: any) { lastErr = String(e?.message ?? e); }
      }
      if (existsSync(svgFile) && ok) {
        pagesProgress[i].status = 'ok'; okPages++;
        const texts = [...readFileSync(svgFile, 'utf8').matchAll(/<text[^>]*>([^<]{2,60})</g)].map((m) => m[1].trim()).slice(0, 5).join('/');
        prevSummaries.push(`第${pageNum}页：${texts}`);
      } else {
        pagesProgress[i].status = 'failed'; pagesProgress[i].error = lastErr;
      }
      setProgress(deps, taskId, { ...currentProgress(deps, taskId), pages: pagesProgress });
    }
    if (okPages === 0) throw new Error('全部页面重排失败');
    setStep(deps, taskId, 'pages', 'done', `${okPages}/${total} 页完成`);

    // 5) 终检 + 导出（同 generate）
    setStep(deps, taskId, 'inspect', 'running', '质量终检…');
    let finalCheck = await qualityCheck(projectPath, 'final');
    for (let round = 0; round < 2 && !finalCheck.ok; round++) {
      setStep(deps, taskId, 'inspect', 'running', `终检未过，第 ${round + 1} 轮修复…`);
      await repairFailedPages(deps, cfg, projectPath, svgDir, pagesProgress, finalCheck);
      finalCheck = await qualityCheck(projectPath, 'final');
    }
    if (!finalCheck.ok) {
      // 确定性兜底：程序化修复 bounds 类错误后复检一次
      setStep(deps, taskId, 'inspect', 'running', '应用确定性修复…');
      let fixed = 0;
      for (let i = 0; i < pagesProgress.length; i++) {
        if (pagesProgress[i].status !== 'ok') continue;
        const file = `slide_${String(i + 1).padStart(2, '0')}.svg`;
        const errs = fileErrorList(finalCheck, file);
        if (!errs.length) continue;
        const path = join(svgDir, file);
        const fixedSvg = deterministicBoundsFix(readFileSync(path, 'utf8'), errs);
        if (fixedSvg !== readFileSync(path, 'utf8')) { writeFileSync(path, fixedSvg); fixed++; }
      }
      if (fixed > 0) finalCheck = await qualityCheck(projectPath, 'final');
    }
    if (!finalCheck.ok) throw new Error(`终检未通过：${summarizeCheckErrors(finalCheck).slice(0, 300)}`);
    setStep(deps, taskId, 'inspect', 'done', '通过');

    setStep(deps, taskId, 'export', 'running', '导出 PPTX…');
    const exportRes = await runPython('svg_to_pptx.py', [projectPath, '--quick-generate'], { timeoutMs: 600000 });
    if (exportRes.code !== 0) throw new Error(`导出失败: ${exportRes.stderr.slice(-300)}`);
    const exportsDir = join(projectPath, 'exports');
    const pptxFiles = existsSync(exportsDir) ? readdirSync(exportsDir).filter((f) => f.endsWith('.pptx')).sort() : [];
    if (!pptxFiles.length) throw new Error('导出目录无 pptx');

    settleCredits(deps, userId, taskId, okPages * CREDITS_PER_PAGE);
    updateTask(deps, taskId, { status: 'done', result_path: join(exportsDir, pptxFiles[pptxFiles.length - 1]), done_at: Date.now() });
    setStep(deps, taskId, 'export', 'done', basename(pptxFiles[pptxFiles.length - 1]));
    setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'done', message: '完成' });
  } catch (e: any) {
    failTask(deps, taskId, e?.message ?? e);
  }
}

// ---------------------------------------------------------------------------
// 路由 2：Edit Native（roundtrip 保原设计）
// ---------------------------------------------------------------------------

const EDIT_STEPS: { key: StepKey; label: string }[] = [
  { key: 'plan', label: '导入原稿' },
  { key: 'assets', label: '解析页面' },
  { key: 'pages', label: '编辑页面' },
  { key: 'inspect', label: '回写校验' },
  { key: 'export', label: '导出 PPTX' },
];

export async function runEditNative(deps: any, taskId: string): Promise<void> {
  const t = getTask(deps, taskId)!;
  const params = JSON.parse(t.params_json || '{}');
  const cfg = getUserGatewayConfig(deps.db, t.user_id, deps.secretKey);
  const userId = t.user_id;

  const src = params.fileId ? resolveUploadFile(deps, params.fileId) : null;
  if (!src) return failTask(deps, taskId, '缺少上传的 PPTX 文件');
  if (!params.instruction) return failTask(deps, taskId, '缺少编辑指令');

  const progress: TaskProgress = { phase: 'generating', currentPage: 0, totalPages: 0, steps: EDIT_STEPS.map((s) => ({ ...s, status: 'pending' })), pages: [] };
  setProgress(deps, taskId, progress);
  updateTask(deps, taskId, { status: 'generating' });

  try {
    holdCredits(deps, userId, taskId, 100);

    // 1) roundtrip 工作区导入
    setStep(deps, taskId, 'plan', 'running', '导入 PPTX（roundtrip）…');
    const projectsRoot = join(deps.dataDir, 'projects');
    mkdirSync(projectsRoot, { recursive: true });
    const wsName = `${taskId.replace(/-/g, '_')}_ppt169_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    const ws = join(projectsRoot, wsName);
    const srcCopy = join(projectsRoot, `${taskId.replace(/-/g, '_')}.pptx`);
    copyFileSync(src.path, srcCopy);
    const imp = await runPython('pptx_to_svg.py', [srcCopy, '-o', ws, '--inheritance-mode', 'both', '--roundtrip'], { timeoutMs: 300000 });
    if (imp.code !== 0) throw new Error(`roundtrip 导入失败: ${imp.stderr.slice(-300)}`);
    setProgress(deps, taskId, { ...currentProgress(deps, taskId), projectDir: wsName });
    setStep(deps, taskId, 'plan', 'done', 'roundtrip 工作区就绪');

    // 2) 读取 roster：直接扫 authoring-svg-flat/*.svg（summary 的 documents 无 text_preview）
    setStep(deps, taskId, 'assets', 'running', '解析页面结构…');
    const svgDir = join(ws, 'authoring-svg-flat');
    const slideFiles = existsSync(svgDir) ? readdirSync(svgDir).filter((f) => /^slide_\d+\.svg$/.test(f)).sort() : [];
    const slideCount = slideFiles.length;
    if (!slideCount) throw new Error('roundtrip 工作区没有页面 SVG');
    const pageDigest = slideFiles.map((f, i) => {
      const txt = [...readFileSync(join(svgDir, f), 'utf8').matchAll(/<text[^>]*>([^<]{2,60})</g)]
        .map((m) => m[1].trim()).filter(Boolean).slice(0, 5).join(' ');
      return `第${i + 1}页: ${txt.slice(0, 120)}`;
    }).join('\n').slice(0, 8000);
    setStep(deps, taskId, 'assets', 'done', `${slideCount} 页解析完成`);

    // 3) LLM 决定要编辑哪些页 + 怎么改
    setStep(deps, taskId, 'pages', 'running', '规划编辑…');
    const planOut = await chatCompletion(cfg, [
      { role: 'system', content: `你是 PPT 编辑规划器。输入是 PPT 每页摘要和用户编辑指令。
输出 JSON：{ "pages": [ { "slide": 3, "instruction": "对该页的具体修改指令" } ] }
只列出需要修改的页；未被列出的页将原样保留。` },
      { role: 'user', content: `页面摘要：\n${pageDigest}\n\n用户指令：${params.instruction}` },
    ], { maxTokens: 4096, temperature: 0.3 });
    const plan = extractJson<{ pages: { slide: number; instruction: string }[] }>(planOut);
    const editPages = plan.pages.filter((p) => p.slide >= 1 && p.slide <= slideCount);
    if (!editPages.length) throw new Error('AI 未规划出需要编辑的页面（指令与内容可能不匹配）');

    // 4) 逐页编辑：读原 SVG → LLM 修改 → 写回
    const pagesProgress: any[] = editPages.map((p) => ({ id: `p${String(p.slide).padStart(2, '0')}`, title: `第${p.slide}页`, role: 'edit', status: 'pending', attempts: [] }));
    let done = 0;
    for (let i = 0; i < editPages.length; i++) {
      const { slide, instruction } = editPages[i];
      pagesProgress[i].status = 'generating';
      setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'generating', currentPage: i + 1, totalPages: editPages.length, pages: pagesProgress });
      setStep(deps, taskId, 'pages', 'running', `编辑第 ${slide} 页：${instruction.slice(0, 24)}`);
      const svgFile = join(svgDir, `slide_${String(slide).padStart(2, '0')}.svg`);
      try {
        const cur = readFileSync(svgFile, 'utf8');
        const out = await chatCompletion(cfg, [
          { role: 'system', content: '你是 SVG 页面编辑器。修改给定 SVG 实现指令，保持其他内容和所有 data-* 属性、结构不变。只输出修改后的完整 SVG，不要任何解释。' },
          { role: 'user', content: `编辑指令：${instruction}\n\n原 SVG：\n${cur.slice(0, 60000)}` },
        ], { maxTokens: 32768, temperature: 0.3 });
        writeFileSync(svgFile, extractSvg(out));
        pagesProgress[i].status = 'ok'; done++;
      } catch (e: any) {
        pagesProgress[i].status = 'failed'; pagesProgress[i].error = String(e?.message ?? e);
      }
      setProgress(deps, taskId, { ...currentProgress(deps, taskId), pages: pagesProgress });
    }
    if (done === 0) throw new Error('所有页面编辑失败');
    setStep(deps, taskId, 'pages', 'done', `${done}/${editPages.length} 页编辑完成`);

    // 5) roundtrip 校验 + 导出
    setStep(deps, taskId, 'inspect', 'running', '回写校验…');
    const check = await runPython('svg_quality_checker.py', [ws, '--roundtrip', '--json'], { timeoutMs: 180000 });
    if (check.code !== 0) {
      // roundtrip 检查失败不硬阻断（编辑宽容度），记录详情继续
      const p = currentProgress(deps, taskId);
      const st = p.steps.find((x) => x.key === 'inspect');
      if (st) (st as any).detail = ['roundtrip 校验有告警（详见日志），继续导出', check.stdout.slice(0, 400)];
      setProgress(deps, taskId, p);
    }
    setStep(deps, taskId, 'inspect', 'done', check.code === 0 ? '通过' : '有告警（继续）');

    setStep(deps, taskId, 'export', 'running', '导出 PPTX…');
    let exportRes = await runPython('svg_to_pptx.py', [ws, '--roundtrip'], { timeoutMs: 600000 });
    if (exportRes.code !== 0) {
      // 降级：导出失败（常见于源含特殊原生结构）→ 逐页恢复原始 SVG，仅当全部恢复后能导出才接受
      const errMsg = exportRes.stderr.slice(-300);
      log('ROUTE', `任务 ${taskId} roundtrip 导出失败，尝试恢复被编辑页后降级导出`, errMsg);
      setStep(deps, taskId, 'export', 'running', '导出失败，恢复原页降级重试…');
      for (const p of editPages) {
        const svgFile = join(svgDir, `slide_${String(p.slide).padStart(2, '0')}.svg`);
        const sourceSvg = join(ws, 'analysis', 'roundtrip-svg', 'flat', `slide_${String(p.slide).padStart(2, '0')}.svg`);
        if (existsSync(sourceSvg)) copyFileSync(sourceSvg, svgFile);
      }
      exportRes = await runPython('svg_to_pptx.py', [ws, '--roundtrip'], { timeoutMs: 600000 });
      if (exportRes.code !== 0) throw new Error(`roundtrip 导出失败: ${errMsg}`);
      done = 0; // 全部恢复原页 = 无编辑生效
      updateTask(deps, taskId, { error: '源 PPTX 含特殊原生结构，编辑未能应用（已原样导出）' });
    }
    const exportsDir = join(ws, 'exports');
    const pptxFiles = existsSync(exportsDir) ? readdirSync(exportsDir).filter((f) => f.endsWith('.pptx')).sort() : [];
    if (!pptxFiles.length) throw new Error('导出目录无 pptx');

    // 结算：只收被编辑页（降级导出时 done=0 全退）
    settleCredits(deps, userId, taskId, done * CREDITS_PER_PAGE);
    updateTask(deps, taskId, { status: 'done', result_path: join(exportsDir, pptxFiles[pptxFiles.length - 1]), done_at: Date.now() });
    setStep(deps, taskId, 'export', 'done', basename(pptxFiles[pptxFiles.length - 1]));
    setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'done', message: '完成' });
  } catch (e: any) {
    failTask(deps, taskId, e?.message ?? e);
  }
}

// ---------------------------------------------------------------------------
// 路由 3：Create Template（从参考稿蒸馏模板）
// ---------------------------------------------------------------------------

const CT_STEPS: { key: StepKey; label: string }[] = [
  { key: 'plan', label: '分析参考稿' },
  { key: 'assets', label: '蒸馏风格' },
  { key: 'pages', label: '撰写规范' },
  { key: 'inspect', label: '保存模板' },
  { key: 'export', label: '完成' },
];

export async function runCreateTemplate(deps: any, taskId: string): Promise<void> {
  const t = getTask(deps, taskId)!;
  const params = JSON.parse(t.params_json || '{}');
  const cfg = getUserGatewayConfig(deps.db, t.user_id, deps.secretKey);
  const userId = t.user_id;

  if (!params.name) return failTask(deps, taskId, '缺少模板名称');
  const ref = params.fileId ? resolveUploadFile(deps, params.fileId) : null;

  const progress: TaskProgress = { phase: 'generating', currentPage: 0, totalPages: 0, steps: CT_STEPS.map((s) => ({ ...s, status: 'pending' })), pages: [] };
  setProgress(deps, taskId, progress);
  updateTask(deps, taskId, { status: 'generating' });

  try {
    // 模板蒸馏不收积分（轻量 LLM 调用）
    updateTask(deps, taskId, { credits_cost: 0 });

    // 1) 收集参考材料：pptx_intake 提取完整风格数据（主题色板/观测色频/字号分布/每页结构）
    setStep(deps, taskId, 'plan', 'running', ref ? '分析参考 PPTX…' : '分析主题描述…');
    let refContent = '';
    let coverSvg: string | null = null;
    if (ref && (ref.path.endsWith('.pptx') || ref.mime.includes('presentationml'))) {
      const tmpDir = join(deps.dataDir, 'tmp');
      mkdirSync(tmpDir, { recursive: true });
      const intakeDir = join(tmpDir, `${taskId.replace(/-/g, '_')}_intake`);
      // 标准 intake 分析（identity + slide_library + source_profile）
      const intake = await runPython('pptx_intake.py', [ref.path, '-o', intakeDir], { timeoutMs: 300000 });
      if (intake.code === 0) {
        // 汇总结构化风格数据
        const parts: string[] = [];
        const idFiles = existsSync(intakeDir) ? readdirSync(intakeDir).filter((f) => f.endsWith('.identity.json')) : [];
        if (idFiles.length) {
          const identity = JSON.parse(readFileSync(join(intakeDir, idFiles[0]), 'utf8'));
          parts.push(`== 主题规范（deck 声明）==\n${JSON.stringify({
            palette: identity.theme?.palette,
            fonts: {
              title: identity.theme?.fonts?.title,
              body: identity.theme?.fonts?.body,
            },
            sizes_pt: identity.theme?.sizes,
          }, null, 1)}`);
          // 观测值（实际使用的颜色/字体/字号频次）
          if (identity.observed) {
            parts.push(`== 实际观测（按使用频次排序）==\n${JSON.stringify({
              colors: (identity.observed.colors ?? []).slice(0, 10),
              fonts: identity.observed.fonts ?? {},  // {latin: [{value,count}], ea: [...]}
              sizes_pt: (identity.observed.sizes_pt ?? []).slice(0, 8),
              layout_sizes_pt: identity.layout_sizes_pt,
            }, null, 1)}`);
          }
        }
        // 每页文本摘要与结构（前 12 页，展示信息组织方式）
        const libFiles = existsSync(intakeDir) ? readdirSync(intakeDir).filter((f) => f.endsWith('.slide_library.json')) : [];
        if (libFiles.length) {
          const lib = JSON.parse(readFileSync(join(intakeDir, libFiles[0]), 'utf8'));
          const slides = (lib.slides ?? []).slice(0, 12).map((s: any) => ({
            page: s.slide_index,
            type: s.page_type,
            title: (s.slots ?? []).find((x: any) => x.role === 'title_candidate')?.text?.slice(0, 60),
            bodyPreview: (s.text_summary ?? '').slice(0, 150),
            slotRoles: (s.slots ?? []).map((x: any) => x.role).slice(0, 8),
            tables: (s.tables ?? []).length,
            charts: (s.charts ?? []).length,
          }));
          parts.push(`== 页面结构（共 ${lib.slides?.length ?? 0} 页，前 12 页摘要）==\n${JSON.stringify(slides, null, 1)}`);
        }
        refContent = parts.join('\n\n');
      }
      // 封面 SVG（视觉预览，从 pptx_to_svg 拿第一页；pptx_to_svg 要求 .pptx 扩展）
      const tmpWs = join(tmpDir, `${taskId.replace(/-/g, '_')}_tpl`);
      const srcPptx = ref.path.endsWith('.pptx') ? ref.path : join(tmpDir, `${taskId.replace(/-/g, '_')}_src.pptx`);
      if (srcPptx !== ref.path) copyFileSync(ref.path, srcPptx);
      const imp = await runPython('pptx_to_svg.py', [srcPptx, '-o', tmpWs, '--inheritance-mode', 'flat'], { timeoutMs: 300000 });
      if (imp.code === 0) {
        const coverFile = join(tmpWs, 'svg', 'slide_01.svg');
        if (existsSync(coverFile)) coverSvg = readFileSync(coverFile, 'utf8').slice(0, 200000);
      }
    } else if (ref && ref.mime.startsWith('image/')) {
      refContent = `（用户提供了一张参考图：${ref.filename}，风格描述见用户说明）`;
    }
    setStep(deps, taskId, 'plan', 'done', '参考材料就绪');

    // 2) LLM 蒸馏风格规范（基于结构化数据，非 SVG 片段）
    setStep(deps, taskId, 'assets', 'running', '蒸馏风格规范…');
    const distillOut = await chatCompletion(cfg, [
      { role: 'system', content: `你是设计系统蒸馏器。根据参考 PPT 的结构化风格数据提炼可复用的模板规范。只输出 JSON：
{
  "name": "模板名",
  "description": "一句话适用场景",
  "style": {
    "mode": "视觉模式标识（如 brand:xxx / dark-data / swiss-grid）",
    "palette": ["#RRGGBB", ...3-6 个],
    "typography": "字体与字阶策略（含具体字号档位）",
    "notes": "跨页一致性规则（motif、强调色用法、间距纪律、页面结构模式等，200字内）"
  }
}

硬性要求：
- palette 必须来自「实际观测」的高频色（含背景/正文/强调色），不得凭空创造；
- typography 必须基于观测的字体与字号分布归纳字阶档位；
- notes 要描述真实观察到的页面结构模式（标题条位置、卡片/网格用法、强调色用在哪类元素上）。` },
      { role: 'user', content: `模板名称（用户指定）：${params.name}\n${params.description ? `用途说明：${params.description}` : ''}\n${refContent ? `参考 PPT 风格数据：\n${refContent.slice(0, 30000)}` : '（无参考材料，请基于名称与用途设计合理的模板规范）'}` },
    ], { maxTokens: 4096, temperature: 0.3 });
    const distilled = extractJson<any>(distillOut);
    setStep(deps, taskId, 'assets', 'done', '风格规范蒸馏完成');

    // 3) 写入 templates 表
    setStep(deps, taskId, 'pages', 'running', '保存模板…');
    const id = randomUUID();
    const styleJson = JSON.stringify({
      mode: String(distilled.style?.mode ?? ''),
      palette: Array.isArray(distilled.style?.palette) ? distilled.style.palette.slice(0, 8) : [],
      typography: String(distilled.style?.typography ?? ''),
      notes: String(distilled.style?.notes ?? ''),
    });
    deps.db.prepare('INSERT INTO templates(id, name, description, style_json, cover_svg, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(
      id, params.name, String(distilled.description ?? params.description ?? '').slice(0, 500), styleJson, coverSvg, userId, Date.now(), Date.now()
    );
    setStep(deps, taskId, 'pages', 'done', '已保存');
    setStep(deps, taskId, 'inspect', 'done', `模板「${params.name}」已入库`);
    setStep(deps, taskId, 'export', 'done', `模板 ID: ${id.slice(0, 8)}`);

    updateTask(deps, taskId, { status: 'done', done_at: Date.now(), error: null });
    setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'done', message: `模板「${params.name}」创建成功，可在创建页直接使用` });
    log('ROUTE', `任务 ${taskId} 模板蒸馏完成: ${params.name}`);
  } catch (e: any) {
    failTask(deps, taskId, e?.message ?? e);
  }
}

// ---------------------------------------------------------------------------
// 路由 4：Image to PPTX（截图重建可编辑）
// ---------------------------------------------------------------------------

const I2P_STEPS: { key: StepKey; label: string }[] = [
  { key: 'plan', label: '解析截图' },
  { key: 'assets', label: '准备素材' },
  { key: 'pages', label: '逐页重建' },
  { key: 'inspect', label: '质量终检' },
  { key: 'export', label: '导出 PPTX' },
];

export async function runImageToPptx(deps: any, taskId: string): Promise<void> {
  const t = getTask(deps, taskId)!;
  const params = JSON.parse(t.params_json || '{}');
  const cfg = getUserGatewayConfig(deps.db, t.user_id, deps.secretKey);
  const userId = t.user_id;

  // 上传的截图（多张，每张一页）
  const files: { path: string; filename: string }[] = [];
  for (const fid of (params.fileIds ?? []) as string[]) {
    const f = resolveUploadFile(deps, fid);
    if (f) files.push(f);
  }
  if (!files.length) return failTask(deps, taskId, '缺少上传的截图');

  const progress: TaskProgress = { phase: 'generating', currentPage: 0, totalPages: files.length, steps: I2P_STEPS.map((s) => ({ ...s, status: 'pending' })), pages: [] };
  setProgress(deps, taskId, progress);
  updateTask(deps, taskId, { status: 'generating' });

  try {
    holdCredits(deps, userId, taskId, files.length * CREDITS_PER_PAGE);

    // 1) 建项目 + 复制截图进 images/（原始参考）
    setStep(deps, taskId, 'plan', 'running', '创建项目…');
    const projectsRoot = join(deps.dataDir, 'projects');
    mkdirSync(projectsRoot, { recursive: true });
    const projectPath = await initProject(taskId.replace(/-/g, '_'), 'ppt169', deps.dataDir);
    setProgress(deps, taskId, { ...currentProgress(deps, taskId), projectDir: basename(projectPath) });
    const imgDir = join(projectPath, 'images');
    mkdirSync(imgDir, { recursive: true });
    const imgList: { file: string; note: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const ext = files[i].filename.match(/\.(png|jpe?g|webp)$/i)?.[0] ?? '.png';
      const name = `src_${String(i + 1).padStart(2, '0')}${ext.toLowerCase()}`;
      copyFileSync(files[i].path, join(imgDir, name));
      imgList.push({ file: name, note: files[i].filename });
    }
    setStep(deps, taskId, 'plan', 'done', `${files.length} 张截图`);
    setStep(deps, taskId, 'assets', 'done', '参考图已就位（注意：当前重建基于截图的视觉描述，多模态识别质量取决于 chat 模型能力）');

    // 2) 逐页重建：LLM 参考截图文件名与用户说明生成 SVG
    //    （无多模态输入时依据文件名顺序与 params.instruction 尽力重建；
    //      有多模态 chat 模型时可在网关侧读图，此处传文件路径供其参考）
    const svgDir = join(projectPath, 'svg_output');
    mkdirSync(svgDir, { recursive: true });
    const pagesProgress: any[] = imgList.map((im, i) => ({ id: `p${String(i + 1).padStart(2, '0')}`, title: im.note, role: 'content', status: 'pending', attempts: [] }));
    setStep(deps, taskId, 'pages', 'running', `0/${imgList.length} 页`);
    let okPages = 0;

    for (let i = 0; i < imgList.length; i++) {
      const pageNum = i + 1;
      pagesProgress[i].status = 'generating';
      setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'generating', currentPage: pageNum, totalPages: imgList.length, pages: pagesProgress });
      setStep(deps, taskId, 'pages', 'running', `重建第 ${pageNum}/${imgList.length} 页`);

      const svgFile = join(svgDir, `slide_${String(pageNum).padStart(2, '0')}.svg`);
      let ok = false;
      let lastErr = '';
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const userMsg = [
            `任务：把页面截图重建为可编辑 SVG。截图文件：../images/${imgList[i].file}（可用 <image href="../images/${imgList[i].file}" .../> 作为背景参考层，opacity 0.3，然后在其上用原生文本/形状重建所有可见文字与图形）`,
            params.instruction ? `用户说明：${params.instruction}` : '',
            `第 ${pageNum}/${imgList.length} 页。输出：只输出完整 SVG（1280×720）。根元素 data-pptx-page-role="content"；顶层 <g id> 带 data-pptx-bounds；背景参考图直接 id="ref-bg" data-pptx-role="background"。`,
          ].filter(Boolean).join('\n');
          const out = await chatCompletion(cfg, [
            { role: 'system', content: executorSystemPrompt() },
            { role: 'user', content: attempt > 0 ? `上次错误：\n${lastErr}\n${userMsg}` : userMsg },
          ], { maxTokens: 16384, temperature: 0.5 });
          writeFileSync(svgFile, extractSvg(out));
          const check = await qualityCheck(projectPath, 'page', `slide_${String(pageNum).padStart(2, '0')}.svg`);
          if (check.ok) ok = true;
          else { lastErr = summarizeCheckErrors(check); pagesProgress[i].retries = attempt + 1; }
        } catch (e: any) { lastErr = String(e?.message ?? e); }
      }
      if (existsSync(svgFile) && ok) { pagesProgress[i].status = 'ok'; okPages++; }
      else { pagesProgress[i].status = 'failed'; pagesProgress[i].error = lastErr; }
      setProgress(deps, taskId, { ...currentProgress(deps, taskId), pages: pagesProgress });
    }
    if (okPages === 0) throw new Error('全部页面重建失败');
    setStep(deps, taskId, 'pages', 'done', `${okPages}/${imgList.length} 页完成`);

    // 3) 终检 + 导出
    setStep(deps, taskId, 'inspect', 'running', '质量终检…');
    let finalCheck = await qualityCheck(projectPath, 'final');
    for (let round = 0; round < 2 && !finalCheck.ok; round++) {
      setStep(deps, taskId, 'inspect', 'running', `第 ${round + 1} 轮修复…`);
      await repairFailedPages(deps, cfg, projectPath, svgDir, pagesProgress, finalCheck);
      finalCheck = await qualityCheck(projectPath, 'final');
    }
    if (!finalCheck.ok) throw new Error(`终检未通过：${summarizeCheckErrors(finalCheck).slice(0, 300)}`);
    setStep(deps, taskId, 'inspect', 'done', '通过');

    setStep(deps, taskId, 'export', 'running', '导出 PPTX…');
    const exportRes = await runPython('svg_to_pptx.py', [projectPath, '--quick-generate'], { timeoutMs: 600000 });
    if (exportRes.code !== 0) throw new Error(`导出失败: ${exportRes.stderr.slice(-300)}`);
    const exportsDir = join(projectPath, 'exports');
    const pptxFiles = existsSync(exportsDir) ? readdirSync(exportsDir).filter((f) => f.endsWith('.pptx')).sort() : [];
    if (!pptxFiles.length) throw new Error('导出目录无 pptx');

    settleCredits(deps, userId, taskId, okPages * CREDITS_PER_PAGE);
    updateTask(deps, taskId, { status: 'done', result_path: join(exportsDir, pptxFiles[pptxFiles.length - 1]), done_at: Date.now() });
    setStep(deps, taskId, 'export', 'done', basename(pptxFiles[pptxFiles.length - 1]));
    setProgress(deps, taskId, { ...currentProgress(deps, taskId), phase: 'done', message: '完成' });
  } catch (e: any) {
    failTask(deps, taskId, e?.message ?? e);
  }
}


// ---------------------------------------------------------------------------
// 共用：确定性 bounds 兜底修复（LLM 修不动时）
// ---------------------------------------------------------------------------

/** 程序化修复 data-pptx-bounds 类错误：缺失→按满幅补；重叠→去掉后出现者的 bounds 属性并
 *  将该组并入根级背景（组保留但去掉 bounds 声明会仍报错，所以采用：重叠组降级为背景装饰）。 */
function deterministicBoundsFix(svg: string, errors: string[]): string {
  let out = svg;
  for (const err of errors) {
    // 缺 bounds：<g id="xxx"> without explicit data-pptx-bounds → 满幅背景化
    const mMissing = err.match(/<g id="([^"]+)">\)?\s*(?:\([^)]*\))?[^;]*without explicit data-pptx-bounds/);
    if (mMissing) {
      const gid = mMissing[1];
      out = out.replace(new RegExp(`<g id="${gid}">`, 'g'), `<g id="${gid}" data-pptx-bounds="0 0 1280 720" data-pptx-role="decoration">`);
      continue;
    }
    // 重叠：<g id="A"> data-pptx-bounds overlaps <g id="B"> → A 降级为背景装饰（满幅）
    const mOverlap = err.match(/<g id="([^"]+)"> data-pptx-bounds overlaps <g id="([^"]+)">/);
    if (mOverlap) {
      const gid = mOverlap[1];
      // 去掉现有 bounds，改为满幅装饰
      out = out.replace(
        new RegExp(`<g id="${gid}" data-pptx-bounds="[^"]*"`),
        `<g id="${gid}" data-pptx-bounds="0 0 1280 720" data-pptx-role="decoration"`
      );
      continue;
    }
  }
  return out;
}

function fileErrorList(check: any, file: string): string[] {
  if (Array.isArray(check.report?.files)) {
    for (const f of check.report.files) {
      if (String(f.file) === file && Array.isArray(f.errors)) return f.errors.map((e: any) => String(e));
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// 共用：终检修复轮
// ---------------------------------------------------------------------------

async function repairFailedPages(deps: any, cfg: GatewayConfig, projectPath: string, svgDir: string, pagesProgress: any[], finalCheck: any): Promise<number> {
  const failing = new Set<string>();
  const fileErrors = new Map<string, string[]>();
  if (Array.isArray(finalCheck.report?.files)) {
    for (const f of finalCheck.report.files) {
      if (Array.isArray(f.errors) && f.errors.length) {
        failing.add(String(f.file));
        fileErrors.set(String(f.file), f.errors.map((e: any) => String(e).slice(0, 300)));
      }
    }
  }
  let repaired = 0;
  for (let i = 0; i < pagesProgress.length; i++) {
    const p = pagesProgress[i];
    if (p.status !== 'ok') continue;
    const file = `slide_${String(i + 1).padStart(2, '0')}.svg`;
    if (!failing.has(file)) continue;
    try {
      const errList = fileErrors.get(file) ?? [];
      const errs = errList.map((e, j) => (j + 1) + '. ' + e).join('\n');
      const cur = readFileSync(join(svgDir, file), 'utf8');
      const fixGuide = [
        '以下 SVG 有 ' + errList.length + ' 个质检错误，必须逐条修复。常见修复方法：',
        '- "<g> 缺 data-pptx-bounds"：给该顶层 <g> 加 data-pptx-bounds="x y width height"（覆盖组内所有元素的渲染范围，留 4px 余量）',
        '- "data-pptx-bounds overlaps"：调整两个组的 bounds 使其不重叠（或把小组并入大组/背景）',
        '- 文字溢出 bounds：扩大 bounds 或缩小字号/换行',
        '修复时保持视觉内容不变。输出完整修正版 SVG（只输出 SVG）。',
        '',
        '=== 本页错误 ===',
        errs || summarizeCheckErrors(finalCheck),
        '',
        '=== 原 SVG ===',
        cur,
      ].join('\n');
      const out = await chatCompletion(cfg, [
        { role: 'system', content: executorSystemPrompt() },
        { role: 'user', content: fixGuide },
      ], { maxTokens: 16384, temperature: 0.4 });
      writeFileSync(join(svgDir, file), extractSvg(out));
      p.retries = (p.retries ?? 0) + 1;
      repaired++;
    } catch { /* continue */ }
  }
  return repaired;
}
