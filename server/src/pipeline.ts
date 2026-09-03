import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { log, logError } from './logger.js';

/** vendor 的 ppt-master skill 目录（pipeline/ 下含 .venv） */
export const SKILL_DIR = join(import.meta.dirname, '..', '..', 'pipeline');
export const PY = join(SKILL_DIR, '.venv', 'bin', 'python');

export interface PipelineResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 运行 skill 内的 Python 脚本（确定性管线：checker / finalizer / 转换器等） */
export function runPython(script: string, args: string[], opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string> } = {}): Promise<PipelineResult> {
  return new Promise((resolve, reject) => {
    if (!existsSync(PY)) {
      return reject(new Error(`Python venv 不存在: ${PY}，请先安装 pipeline 依赖`));
    }
    const scriptPath = join(SKILL_DIR, 'scripts', script);
    if (!existsSync(scriptPath)) {
      return reject(new Error(`脚本不存在: ${scriptPath}`));
    }
    const proc = spawn(PY, [scriptPath, ...args], {
      cwd: opts.cwd ?? SKILL_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: '1', LANG: 'C.UTF-8', ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, opts.timeoutMs ?? 300000);

    proc.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 200000) stdout = stdout.slice(-200000); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 200000) stderr = stderr.slice(-200000); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`脚本 ${script} 执行超时`));
      log('PIPELINE', `${script} ${args.join(' ')} -> exit ${code}`);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 质检 SVG。按上游 quick-generate 契约：
 *  - early：7+ 页的 P05 后早期门（检查已写全部页）
 *  - final：全部页完成后终检（--quick-generate --canonical-authoring）
 *  - page：单页模式（编辑器/修复轮用）
 *  报告读自 validation/ 目录 */
export async function qualityCheck(
  target: string,
  stage: 'page' | 'early' | 'final',
  pageFile?: string,
): Promise<{ ok: boolean; report: any; raw: string }> {
  const args = [target, '--stage', stage, '--quick-generate'];
  if (stage === 'final') args.push('--canonical-authoring');
  if (stage === 'page' && pageFile) args.push('--page', pageFile);
  args.push('--json');
  const r = await runPython('svg_quality_checker.py', args, { timeoutMs: 180000 });
  // 报告文件优先（stdout 混杂日志不可靠）
  const reportFile = stage === 'page' ? join(target, 'validation', 'svg_quality_page_report.json') : join(target, 'validation', 'svg_quality_report.json');
  let report: any = null;
  try {
    if (existsSync(reportFile)) report = JSON.parse(readFileSync(reportFile, 'utf8'));
  } catch { /* 保持 null */ }
  if (!report) {
    try {
      const idx = r.stdout.lastIndexOf('{');
      if (idx >= 0) report = JSON.parse(r.stdout.slice(idx));
    } catch { /* 保持 null */ }
  }
  if (r.code !== 0 && !report) {
    logError('PIPELINE', `quality checker exit ${r.code}`, r.stderr.slice(0, 500));
  }
  return { ok: r.code === 0, report, raw: r.stdout };
}

/** 初始化 ppt-master 项目（以 baseDir 为 cwd，项目建在 baseDir/projects/ 下），返回项目绝对路径 */
export async function initProject(name: string, format: string, baseDir: string): Promise<string> {
  const r = await runPython('project_manager.py', ['init', name, '--format', format], { cwd: baseDir, timeoutMs: 60000 });
  const m = r.stdout.match(/Project created:\s*(.+)/);
  if (r.code !== 0 || !m) throw new Error(`项目初始化失败: ${r.stderr.slice(0, 300)}`);
  return m[1].trim();
}
