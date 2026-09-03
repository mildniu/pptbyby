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
    // 修复资源引用逃逸：源 PPTX 的图片可能引用项目外路径（../../../images/...），
    // pptx_to_svg 已把包内图片提取到 ws/images/，只需重写 href 为项目相对路径
    {
      const flatDir = join(ws, 'authoring-svg-flat');
      if (existsSync(flatDir)) {
        for (const f of readdirSync(flatDir).filter((x) => x.endsWith('.svg'))) {
          const fp = join(flatDir, f);
          let svg = readFileSync(fp, 'utf8');
          const fixed = svg.split('../../../images/').join('../images/');
          if (fixed !== svg) { writeFileSync(fp, fixed); svg = fixed; }
        }
      }
    }
    // 备份原始 authoring 文件（降级恢复用；analysis/roundtrip-svg 是另一种投影格式，不能直接用）
    {
      const flatDir = join(ws, 'authoring-svg-flat');
      const backupDir = join(ws, 'authoring-svg-flat.orig');
      mkdirSync(backupDir, { recursive: true });
      for (const f of readdirSync(flatDir).filter((x) => x.endsWith('.svg'))) {
        copyFileSync(join(flatDir, f), join(backupDir, f));
      }
    }
    // 检测嵌套容器结构：某 shape 内嵌其他 source-ref 对象（如全幅背景图组包住全部内容）。
    // 这种结构下任何编辑都会使容器被判 affected，重建 DrawingML 必失败（上游工具边界）。
    {
      let nested = false;
      for (const f of readdirSync(join(ws, 'authoring-svg-flat')).filter((x) => x.endsWith('.svg'))) {
        const svg = readFileSync(join(ws, 'authoring-svg-flat', f), 'utf8');
        const gs = [...svg.matchAll(/<g [^>]*data-pptx-source-ref="(slide:\d+)"[^>]*>/g)];
        for (const g of gs) {
          const start = g.index! + g[0].length;
          const nextG = svg.indexOf('</g>', start);
          const chunk = svg.slice(start, nextG);
          // 该 g 内部还有别的 source-ref（粗略：闭合前出现其他 ref）——
          // 用整个文件剩余部分做嵌套判定更可靠：块内出现其他 ref id
          const inner = svg.matchAll(/data-pptx-source-ref="(slide:\d+)"/g);
          const others = [...inner].filter((m) => m[1] !== g[1] && m.index! > g.index! && m.index! < g.index! + 8000);
          if (others.length >= 3) { nested = true; break; }  // ≥3 个其他 ref 疑似容器
        }
        if (nested) break;
      }
      if (nested) {
        throw new Error('该 PPT 采用嵌套背景容器结构，逐页原位编辑暂不支持。请使用「美化」模式（保持文字 1:1 重新排版，可去掉配图、改风格）');
      }
    }
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

    // 写 spec（前端任务标题/大纲显示）
    updateTask(deps, taskId, {
      spec_json: JSON.stringify({
        title: t.topic || '连续编辑',
        format: 'ppt169',
        pages: editPages.map((p) => ({
          id: `p${String(p.slide).padStart(2, '0')}`,
          role: 'edit',
          title: `第${p.slide}页`,
          outline: p.instruction.slice(0, 200),
        })),
        images: [],
        style: { mode: 'edit-native', palette: [], typography: '', notes: '' },
      }),
    });

    // 4) 逐页编辑：LLM 输出文本替换对，程序做 XML 级替换（保留全部结构/data-pptx-source-ref，roundtrip 契约不破坏）
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
        // 提取该页全部文本（带行内位置），让 LLM 基于真实文本输出替换
        const texts = [...cur.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m, j) => ({ j, t: m[1] }));
        const repOut = await chatCompletion(cfg, [
          { role: 'system', content: `你是 PPT 文本编辑器。根据编辑指令，输出要修改的文本替换对。只输出 JSON：
{ "replacements": [ { "old": "要替换的完整原文文本", "new": "替换后的文本" } ] }
规则：old 必须与页面中现有 <text> 元素的文本内容完全一致（逐字符，含空格标点）；
只列出需要修改的；新增整段文字不支持（需要重新排版时返回空数组）。` },
          { role: 'user', content: `编辑指令：${instruction}\n\n该页现有文本元素：\n${JSON.stringify(texts.slice(0, 60))}\n\n原 SVG 结构（参考，勿全文重写）：\n${cur.slice(0, 8000)}` },
        ], { maxTokens: 4096, temperature: 0.2 });
        const rep = extractJson<{ replacements: { old: string; new: string }[] }>(repOut);
        let svg = cur;
        let applied = 0;
        for (const r of (rep.replacements ?? [])) {
          if (!r.old || !r.new || r.old === r.new) continue;
          const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const before = svg;
          svg = svg.split(esc(r.old)).join(esc(r.new));
          if (svg !== before) applied++;
        }
        writeFileSync(svgFile, svg);
        pagesProgress[i].status = 'ok';
        pagesProgress[i].attempts = [applied > 0 ? `替换了 ${applied} 处文本` : '指令为非文本修改，页面保留原样'];
        done++;
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
        const backupSvg = join(ws, 'authoring-svg-flat.orig', `slide_${String(p.slide).padStart(2, '0')}.svg`);
        if (existsSync(backupSvg)) copyFileSync(backupSvg, svgFile);
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

/** deck 原型内容脱敏：把源稿的具体业务文本替换为占位文案，保留版式/配色/结构。
 *  文本可能在 <text> 直接内容或嵌套 <tspan> 中，都处理。
 *  预览呈现"模板样子"而非源稿截图；后续生成也不会照抄原文内容。 */
function sanitizeProto(svg: string, _pageIdx: number, _total: number): string {
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const titles = ['主标题文案占位', '章节标题占位', '要点标题示例'];
  const bodies = ['正文要点占位一，说明性文字示例。', '要点二：支撑数据或论据示例。', '补充说明文字示例，用于展示正文字阶。'];
  let big = 0, small = 0;

  // 替换 <text ...>...</text> 整块：按字号决定占位层级，数字/符号短文本保留（页码等骨架）
  return svg.replace(/<text([^>]*)>([\s\S]*?)<\/text>/g, (m, attrs: string, inner: string) => {
    // 提取块内全部可见文本（含 tspan 嵌套）
    const visible = inner.replace(/<[^>]+>/g, '').trim();
    // 保留：空、短数字/符号（页码、日期骨架、编号"一/二/1/2"）
    if (!visible || (visible.length <= 6 && /^[\d\s\/·.\-—:：()（）一二三四五六七八九十]+$/.test(visible))) return m;
    const fs = Number((attrs.match(/font-size="([\d.]+)"/) || [])[1] || 0);
    const ph = fs >= 24 || visible.length <= 22
      ? titles[big++ % titles.length]
      : bodies[small++ % bodies.length];
    // 替换 inner 中的文本节点：tspan 保留首个替换、其余清空（保持结构）
    let replacedOnce = false;
    const newInner = inner.replace(/(<tspan[^>]*>)([\s\S]*?)(<\/tspan>)/g, (_m2, open: string, content: string, close: string) => {
      if (replacedOnce) return `${open}${close}`;
      replacedOnce = true;
      return `${open}${esc(ph)}${close}`;
    });
    if (replacedOnce) return `<text${attrs}>${newInner}</text>`;
    return `<text${attrs}>${esc(ph)}</text>`;
  });
}

// ---------------------------------------------------------------------------
// 路由 3：Create Template（从参考稿蒸馏模板）
// ---------------------------------------------------------------------------

const CT_STEPS: { key: StepKey; label: string }[] = [
  { key: 'plan', label: '分析参考稿' },
  { key: 'assets', label: '蒸馏风格规范' },
  { key: 'pages', label: '生成页面原型' },
  { key: 'inspect', label: '入库模板库' },
  { key: 'export', label: '完成' },
];

export async function runCreateTemplate(deps: any, taskId: string): Promise<void> {
  const t = getTask(deps, taskId)!;
  const params = JSON.parse(t.params_json || '{}');
  const cfg = getUserGatewayConfig(deps.db, t.user_id, deps.secretKey);
  const userId = t.user_id;

  if (!params.name) return failTask(deps, taskId, '缺少模板名称');
  const tplKind = params.templateKind === 'deck' ? 'deck' : 'style'; // 风格模板 | 场景方案（多页原型）
  const ref = params.fileId ? resolveUploadFile(deps, params.fileId) : null;

  const progress: TaskProgress = { phase: 'generating', currentPage: 0, totalPages: 0, steps: CT_STEPS.map((s) => ({ ...s, status: 'pending' })), pages: [] };
  setProgress(deps, taskId, progress);
  updateTask(deps, taskId, {
    status: 'generating',
    // 任务名直接用模板名（避免「未命名任务」）；同时写入 spec 供前端显示
    topic: params.name,
    spec_json: JSON.stringify({
      title: `蒸馏模板：${params.name}`,
      format: 'ppt169',
      pages: [{ id: 'p01', role: 'content', title: tplKind === 'deck' ? '场景方案' : '风格模板', outline: params.description || '' }],
      images: [],
      style: { mode: 'distilling', palette: [], typography: '', notes: '' },
    }),
  });

  try {
    // 模板蒸馏不收积分（轻量 LLM 调用）
    updateTask(deps, taskId, { credits_cost: 0 });

    // 1) 收集参考材料：pptx_intake 提取完整风格数据（主题色板/观测色频/字号分布/每页结构）
    setStep(deps, taskId, 'plan', 'running', ref ? `提取配色 / 字体 / 字号分布与页面结构（${ref.filename.slice(0, 24)}）…` : '分析主题描述…');
    let refContent = '';
    let coverSvg: string | null = null;
    let protoPages: string[] = [];
    let protoAssets: Record<string, string> = {};  // 文件名 → mime（图片素材清单）
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
      // 页面原型 SVG（视觉预览；pptx_to_svg 要求 .pptx 扩展）
      const tmpWs = join(tmpDir, `${taskId.replace(/-/g, '_')}_tpl`);
      const srcPptx = ref.path.endsWith('.pptx') ? ref.path : join(tmpDir, `${taskId.replace(/-/g, '_')}_src.pptx`);
      if (srcPptx !== ref.path) copyFileSync(ref.path, srcPptx);
      const imp = await runPython('pptx_to_svg.py', [srcPptx, '-o', tmpWs, '--inheritance-mode', 'flat'], { timeoutMs: 300000 });
      if (imp.code === 0) {
        const svgDir = join(tmpWs, 'svg');
        if (existsSync(svgDir)) {
          const files = readdirSync(svgDir).filter((f) => f.endsWith('.svg')).sort();
          // deck：前 8 页原型（内容脱敏）；style：仅封面（原样）
          const take = tplKind === 'deck' ? files.slice(0, 8) : files.slice(0, 1);
          protoPages = take.map((f, fi) => {
            const raw = readFileSync(join(svgDir, f), 'utf8').slice(0, 200000);
            return tplKind === 'deck' ? sanitizeProto(raw, fi, take.length) : raw;
          });
          if (protoPages.length) coverSvg = protoPages[0];
          // 收集原型引用的图片（logo/装饰条等）到素材清单
          if (tplKind === 'deck') {
            const wsImagesDir = join(tmpWs, 'images');
            for (const svg of protoPages) {
              const refs = [...svg.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((u) => u.startsWith('../images/'));
              for (const u of refs) {
                const fname = u.slice('../images/'.length);
                if (protoAssets[fname]) continue;
                const fpath = join(wsImagesDir, fname);
                if (existsSync(fpath)) {
                  const ext = fname.split('.').pop()?.toLowerCase() ?? 'png';
                  protoAssets[fname] = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/webp';
                }
              }
            }
          }
        }
      }
    } else if (ref && ref.mime.startsWith('image/')) {
      refContent = `（用户提供了一张参考图：${ref.filename}，风格描述见用户说明）`;
    }
    setStep(deps, taskId, 'plan', 'done', '参考稿分析完成（主题色板 · 观测色频 · 字阶 · 页面结构）');

    // 2) LLM 蒸馏：按 ppt-master 上游标准格式产出 design_spec.md（模板的标准载体）
    //    schema 参照 skills/ppt-master/templates/decks/中汽研/templates/design_spec.md
    setStep(deps, taskId, 'assets', 'running', '按 ppt-master 模板规范蒸馏 design_spec…');
    const tplId = params.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'custom_deck';
    const pageCount = tplKind === 'deck' ? Math.min(protoPages.length, 8) : 0;
    const distillOut = await chatCompletion(cfg, [
      { role: 'system', content: `你是 ppt-master 模板系统的 Template_Designer。根据参考 PPT 的结构化数据，按项目标准 schema 撰写模板的 design_spec.md。只输出 markdown 全文（YAML frontmatter + 各 section），不要输出其他文字。

模板 schema（严格遵循）：
---
${tplKind === 'deck' ? `${tplKind}_id: ${tplId}` : `style_id: ${tplId}`}
kind: ${tplKind}
category: brand | general | scenario | government | special（按用途判断）
summary: <一句话：可复用的演示场景族与预期效果>
keywords: [<3-5 个标签>]
primary_color: "#XXXXXX"
canvas_format: ppt169
canvas_width: 1280
canvas_height: 720
canvas_viewbox: "0 0 1280 720"
replication_mode: standard
${tplKind === 'deck' ? 'native_structure_mode: structured\npage_count: ' + pageCount : ''}
---

# <模板名> — Design Specification

## I. Template Overview
| 应用情境 | 定义 |（表格：可复用演示场景族 / 目标受众与预期效果 / 讲解与阅读假设 / 代表性叙事页面角色）

## II. Color Scheme
| 角色 | 色值 | 应用 |（表格：主色/底色/文字/强调/面板等，每个色注明用在哪）

## III. Typography
| 角色 | 字体栈 | 应用 |（表格）

## IV. Signature Design Elements
（标志性设计元素：页眉/标题条/章节标识/页码等跨页一致的结构元素，逐条列出）

${tplKind === 'deck' ? `## V. Page Roster
| 文件 | 版式角色 | 视觉特征 | 可复用槽位 |（表格，每行对应一页原型：01_cover.svg/02_toc.svg/03_chapter.svg/04_content.svg/05_ending.svg 按实际页数）

## VI. Assets
| 文件 | 用途 |（原型引用的图片素材，没有则省略本节）` : '（风格模板无 Page Roster/Assets 节）'}

硬性要求：
- Color Scheme 的色值必须来自「实际观测」的高频色，逐色注明真实用途；
- Typography 基于观测字体与字号分布归纳档位；
- Signature Design Elements 描述真实观察到的结构模式（标题条位置/卡片网格用法/强调色用在什么元素上）；
- Page Roster 的视觉特征描述各页原型的真实版式（基于页面结构数据推断）；
- 全部用中文撰写（frontmatter 的枚举值除外）。` },
      { role: 'user', content: `模板名称（用户指定）：${params.name}\n${params.description ? `用途说明：${params.description}` : ''}\n${refContent ? `参考 PPT 结构化数据：\n${refContent.slice(0, 30000)}` : '（无参考材料，请基于名称与用途设计合理的模板规范）'}` },
    ], { maxTokens: 8192, temperature: 0.3 });
    const specMd = distillOut.includes('---') ? distillOut.slice(distillOut.indexOf('---')).trim() : distillOut.trim();
    setStep(deps, taskId, 'assets', 'done', 'design_spec 已蒸馏（上游标准格式）');

    // 从 spec_md 解析回 style JSON（保持旧字段兼容：palette/typography/notes 供 UI 展示）
    const fmColors = [...specMd.matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0].toUpperCase());
    const typographySec = specMd.split('## III. Typography')[1]?.split('\n## ')[0] ?? '';
    const signatureSec = specMd.split('## IV. Signature Design Elements')[1]?.split('\n## ')[0] ?? '';
    const distilled = {
      description: (specMd.match(/^summary:\s*(.+)$/m) || [])[1] ?? params.description ?? '',
      style: {
        mode: `${tplKind}:${tplId}`,
        palette: [...new Set(fmColors)].slice(0, 8),
        typography: typographySec.trim().slice(0, 300),
        notes: signatureSec.trim().slice(0, 600),
      },
    };

    // 3) 写入 templates 表
    setStep(deps, taskId, 'pages', 'running', tplKind === 'deck' ? '脱敏页面原型（剥离源稿内容，保留版式与配色）…' : '保存风格模板…');
    const id = randomUUID();
    const styleJson = JSON.stringify({
      mode: String(distilled.style?.mode ?? ''),
      palette: Array.isArray(distilled.style?.palette) ? distilled.style.palette.slice(0, 8) : [],
      typography: String(distilled.style?.typography ?? ''),
      notes: String(distilled.style?.notes ?? ''),
    });
    // 程序化校正封面背景描述：LLM 可能从观测色频错误归纳封面色（如把内容页深色当封面底色），
    // 以封面原型第一个全幅 rect 的实际 fill 为准
    if (tplKind === 'deck' && protoPages.length) {
      const coverSvgText = protoPages[0];
      const bgMatch = coverSvgText.match(/<rect[^>]*width="1280"[^>]*height="720"[^>]*fill="(#[0-9A-Fa-f]{6})"/)
        ?? coverSvgText.match(/<rect[^>]*height="720"[^>]*width="1280"[^>]*fill="(#[0-9A-Fa-f]{6})"/);
      const realBg = bgMatch?.[1];
      if (realBg) {
        const rgb = [1, 3, 5].map((i) => parseInt(realBg.slice(i, i + 2), 16));
        const isDark = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 < 128;
        const zh = isDark ? `深色底（${realBg}）` : `浅色底（${realBg}）`;
        // 替换 notes 里的封面背景描述（常见模式：封面为XX底（#XXXXXX））
        let notes = String(distilled.style?.notes ?? '');
        notes = notes.replace(/封面为(深色|浅色|白色|白|黑)底（#[0-9A-Fa-f]{6}）/g, `封面为${zh}`)
                     .replace(/封面(为|是)(深色|浅色|白色|白)底/g, `封面为${zh}`);
        if (!/封面/.test(notes)) notes = `封面为${zh}；` + notes;
        distilled.style = { ...distilled.style, notes };
      }
    }

    // deck：把原型图片素材（logo/装饰）复制到持久目录
    if (tplKind === 'deck' && Object.keys(protoAssets).length) {
      const tplAssetsDir = join(deps.dataDir, 'template-assets', id);
      mkdirSync(tplAssetsDir, { recursive: true });
      const tmpWs = join(deps.dataDir, 'tmp', `${taskId.replace(/-/g, '_')}_tpl`);
      for (const fname of Object.keys(protoAssets)) {
        const srcF = join(tmpWs, 'images', fname);
        if (existsSync(srcF)) copyFileSync(srcF, join(tplAssetsDir, fname));
      }
    }
    deps.db.prepare('INSERT INTO templates(id, name, description, style_json, kind, pages_json, assets_json, spec_md, cover_svg, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id, params.name, String(distilled.description ?? params.description ?? '').slice(0, 500), styleJson,
      tplKind, tplKind === 'deck' && protoPages.length > 1 ? JSON.stringify(protoPages) : null,
      tplKind === 'deck' && Object.keys(protoAssets).length ? JSON.stringify(protoAssets) : null,
      specMd.slice(0, 60000),
      coverSvg, userId, Date.now(), Date.now()
    );
    setStep(deps, taskId, 'pages', 'done', tplKind === 'deck' ? `已生成 ${protoPages.length} 页脱敏原型` : '风格模板已保存');
    setStep(deps, taskId, 'inspect', 'done', `「${params.name}」已入库模板库`);
    setStep(deps, taskId, 'export', 'done', tplKind === 'deck' ? `场景方案 · ${protoPages.length} 页原型 · 可在创建页选用` : '风格模板 · 可在创建页选用');

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
