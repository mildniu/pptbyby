import { readFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './pipeline.js';
import { log } from './logger.js';
import { stylePreviewSvg } from './templatePreview.js';

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
  /** 主预览图（有 refImages 用第一张；否则程序化生成风格示意） */
  previewUrl: string;
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

  // brands（品牌 identity：色板+字体+语气；部分品牌带 logo 素材）
  const brandsIdx = readJson(join(tRoot, 'brands', 'brands_index.json')) ?? {};
  for (const [id, meta] of Object.entries<any>(brandsIdx)) {
    const imgs = imgEntries(join(tRoot, 'brands', id, 'images'), 'image').slice(0, 4);
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
      refImages: imgs.map((r) => ({ name: r.name, url: mediaUrl(r.rel) })),
      previewUrl: imgs.length ? mediaUrl(imgs[0].rel) : previewDataUrl({
        mode: `brand:${id}`,
        palette: ['#FFFFFF', meta.primary_color ?? '#C0392B', '#333333', '#F5F5F5'],
        typography: `${id} 品牌规范`, notes: '',
      }, id),
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
      previewUrl: previewDataUrl({
        mode: `style:${id}`,
        palette: ['#FAFAFA', '#2563EB', '#111827', '#E5E7EB'],
        typography: meta.summary ?? '',
        notes: '',
      }, id),
    });
  }

  // decks（场景：页面原型 + 品牌素材）
  // EXCLUDED_DECKS：不进公共内置库的 deck（作为 admin 私有模板单独入库）
  const EXCLUDED_DECKS = new Set(['hebei_telecom']);
  const decksIdx = readJson(join(tRoot, 'decks', 'decks_index.json')) ?? {};
  for (const [id, meta] of Object.entries<any>(decksIdx)) {
    if (EXCLUDED_DECKS.has(id)) continue;
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
      previewUrl: protos.length ? media(protos[0].rel) : (assets.length ? media(assets[0].rel) : previewDataUrl({ mode: `deck:${id}`, palette: meta.primary_color ? [meta.primary_color] : [], typography: '', notes: '' }, id)),
    });
  }

  cache = out;
  log('TPL', `内置模板加载：brands ${Object.keys(brandsIdx).length} / styles ${Object.keys(stylesIdx).length} / decks ${Object.keys(decksIdx).length}，共 ${out.length} 个`);
  return out;
}

/** 把内置模板同步进 templates 表（幂等；deck 类带脱敏原型与素材，统一新规则） */
export function syncBuiltinToTemplates(db: any, dataDir: string): number {
  const tRoot = join(SKILL_DIR, 'templates');
  const kindMap: Record<string, string> = { brand: 'brands', style: 'styles', deck: 'decks' };
  let count = 0;
  for (const t of loadBuiltinTemplates()) {
    const m = t.id.match(/^builtin:(brand|style|deck)\/(.+)$/);
    if (!m) continue;
    const kind = m[1] as 'brand' | 'style' | 'deck';
    const sub = kindMap[kind];
    const specPath = join(tRoot, sub, m[2], 'templates', 'design_spec.md');
    const specMd = existsSync(specPath) ? readFileSync(specPath, 'utf8').slice(0, 60000) : null;

    // deck：原型 SVG（脱敏）+ 素材
    let pagesJson: string | null = null;
    let assetsJson: string | null = null;
    let coverSvg: string | null = null;
    if (kind === 'deck') {
      const dir = join(tRoot, sub, m[2]);
      const protoDir = join(dir, 'templates');
      const protoFiles = existsSync(protoDir) ? readdirSync(protoDir).filter((f) => f.endsWith('.svg')).sort() : [];
      if (protoFiles.length > 1) {
        const pages = protoFiles.map((f) => readFileSync(join(protoDir, f), 'utf8').slice(0, 200000));
        pagesJson = JSON.stringify(pages);
        coverSvg = pages[0];
      }
      // 素材：deck images/ 目录
      const imgDir = join(dir, 'images');
      const assetFiles = existsSync(imgDir) ? readdirSync(imgDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)) : [];
      if (assetFiles.length) {
        const assets: Record<string, string> = {};
        const dstDir = join(dataDir, 'template-assets', t.id.replace(/[:/]/g, '_'));
        mkdirSync(dstDir, { recursive: true });
        for (const f of assetFiles) {
          copyFileSync(join(imgDir, f), join(dstDir, f));
          const ext = f.split('.').pop()?.toLowerCase() ?? 'png';
          assets[f] = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/webp';
        }
        assetsJson = JSON.stringify(assets);
      }
    }

    const styleJson = JSON.stringify({
      mode: t.style.mode,
      palette: t.style.palette,
      typography: t.style.typography,
      notes: t.style.notes,
    });
    db.prepare(`INSERT INTO templates(id, name, description, style_json, kind, pages_json, assets_json, spec_md, cover_svg, created_by, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
                  style_json=excluded.style_json, kind=excluded.kind, pages_json=excluded.pages_json,
                  assets_json=excluded.assets_json, spec_md=excluded.spec_md, cover_svg=excluded.cover_svg, updated_at=excluded.updated_at`)
      .run(
        t.id, t.name, t.summary.slice(0, 500), styleJson, kind,
        pagesJson, assetsJson, specMd, coverSvg,
        'builtin', Date.now(), Date.now()
      );
    count++;
  }
  log('TPL', `内置模板同步入库：${count} 个（含 spec_md/原型/素材，新规则）`);
  return count;
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

/** 风格示意 SVG 转 data URL（无参考图的模板用） */
function previewDataUrl(style: { mode?: string; palette?: string[]; typography?: string; notes?: string }, name: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(stylePreviewSvg(style, name));
}

/** 媒体 URL（中文目录名 percent-encode，浏览器可直接访问） */
export function mediaUrl(rel: string): string {
  return '/media/pipeline/' + rel.split('/').map(encodeURIComponent).join('/');
}
