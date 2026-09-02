import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './pipeline.js';
import { log } from './logger.js';

/**
 * 内置模板：读取 vendor 的 ppt-master 模板库。
 * 三大类（各自 templates/ 下有 design_spec.md 完整规范）：
 *  - brands  品牌模板（20 个，identity-only：色板/字体/语气规范）
 *  - styles  风格模板（12 个，方法与设计默认值：叙事结构/页面角色/图表纪律）
 *  - decks   场景模板（2 个，含 5 页 SVG 原型 + 品牌素材图）
 * 生成 PPT 时把 design_spec.md 的约束注入 Strategist。
 */

export interface BuiltinTemplate {
  id: string;          // builtin:brand/huawei | builtin:style/investor-pitch | builtin:deck/中国电信
  kind: 'brand' | 'style' | 'deck';
  name: string;
  summary: string;
  primaryColor?: string;
  pageCount?: number;
  style: { mode: string; palette: string[]; typography: string; notes: string };
  /** 参考图（deck 的页面原型 SVG 与品牌素材）媒体路径 */
  refImages: { name: string; url: string }[];
}

let cache: BuiltinTemplate[] | null = null;

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 解析 design_spec.md 的 YAML frontmatter */
function parseFrontmatter(path: string): Record<string, string> {
  try {
    const text = readFileSync(path, 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    const out: Record<string, string> = {};
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([a-z_]+):\s*"?(.*?)"?\s*$/);
      if (kv) out[kv[1]] = kv[2];
    }
    return out;
  } catch {
    return {};
  }
}

function imgEntries(dir: string, kind: 'image' | 'svg'): { name: string; url: string; rel: string }[] {
  if (!existsSync(dir)) return [];
  try {
    const exts = kind === 'svg' ? ['.svg'] : ['.png', '.jpg', '.jpeg', '.webp'];
    return readdirSync(dir)
      .filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
      .sort()
      .map((f) => ({ name: f, url: '', rel: join(dir, f).replace(SKILL_DIR + '/', '') }));
  } catch {
    return [];
  }
}

export function loadBuiltinTemplates(): BuiltinTemplate[] {
  if (cache) return cache;
  const out: BuiltinTemplate[] = [];
  const tRoot = join(SKILL_DIR, 'templates');
  const media = (rel: string) => mediaUrl(rel);

  // brands（品牌 identity：色板+字体+语气）
  const brandsIdx = readJson(join(tRoot, 'brands', 'brands_index.json')) ?? {};
  for (const [id, meta] of Object.entries<any>(brandsIdx)) {
    out.push({
      id: `builtin:brand/${id}`,
      kind: 'brand',
      name: id,
      summary: meta.summary ?? '',
      primaryColor: meta.primary_color,
      style: {
        mode: `brand:${id}`,
        palette: meta.primary_color ? [meta.primary_color] : [],
        typography: '见品牌规范（design_spec.md）',
        notes: meta.summary ?? '',
      },
      refImages: [],
    });
  }

  // styles（方法与设计默认值）
  const stylesIdx = readJson(join(tRoot, 'styles', 'styles_index.json')) ?? {};
  for (const [id, meta] of Object.entries<any>(stylesIdx)) {
    out.push({
      id: `builtin:style/${id}`,
      kind: 'style',
      name: id,
      summary: meta.summary ?? '',
      style: {
        mode: `style:${id}`,
        palette: [],
        typography: '见风格规范（design_spec.md）',
        notes: meta.summary ?? '',
      },
      refImages: [],
    });
  }

  // decks（场景：页面原型 + 品牌素材）
  const decksIdx = readJson(join(tRoot, 'decks', 'decks_index.json')) ?? {};
  for (const [id, meta] of Object.entries<any>(decksIdx)) {
    const dir = join(tRoot, 'decks', id);
    const protos = imgEntries(join(dir, 'templates'), 'svg');     // 页面原型
    const assets = imgEntries(join(dir, 'images'), 'image');       // logo/横幅等素材
    out.push({
      id: `builtin:deck/${id}`,
      kind: 'deck',
      name: id,
      summary: meta.summary ?? '',
      primaryColor: meta.primary_color,
      pageCount: meta.page_count,
      style: {
        mode: `deck:${id}`,
        palette: meta.primary_color ? [meta.primary_color] : [],
        typography: '见场景规范（design_spec.md）',
        notes: meta.summary ?? '',
      },
      refImages: [...protos, ...assets].map((r) => ({ name: r.name, url: media(r.rel) })),
    });
  }

  cache = out;
  log('TPL', `内置模板加载：brands ${Object.keys(brandsIdx).length} / styles ${Object.keys(stylesIdx).length} / decks ${Object.keys(decksIdx).length}，共 ${out.length} 个`);
  return out;
}

/** 内置模板的 design_spec.md 全文（注入 Strategist 的约束） */
export function builtinSpecText(templateId: string): string | null {
  const t = loadBuiltinTemplates().find((x) => x.id === templateId);
  if (!t) return null;
  const m = t.id.match(/^builtin:(brand|style|deck)\/(.+)$/);
  if (!m) return null;
  const sub = { brand: 'brands', style: 'styles', deck: 'decks' }[m[1] as 'brand' | 'style' | 'deck'];
  const specPath = join(SKILL_DIR, 'templates', sub, m[2], 'templates', 'design_spec.md');
  if (!existsSync(specPath)) return null;
  return readFileSync(specPath, 'utf8').slice(0, 30000);
}

/** 媒体 URL（中文目录名 percent-encode，浏览器可直接访问） */
export function mediaUrl(rel: string): string {
  return '/media/pipeline/' + rel.split('/').map(encodeURIComponent).join('/');
}
