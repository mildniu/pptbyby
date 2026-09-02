import type { Db } from './db.js';

/**
 * 程序化生成模板风格预览 SVG（用于无封面/参考图的模板）。
 * 基于模板 style（palette/typography/notes）渲染一张示意封面：
 * 顶部标题条 + 色板条 + 字阶示意 + 卡片布局示意，忠实呈现模板的配色与结构。
 */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function stylePreviewSvg(style: { mode?: string; palette?: string[]; typography?: string; notes?: string }, name: string): string {
  const palette = (style.palette ?? []).filter((c) => /^#[0-9A-Fa-f]{6}$/.test(c));
  const bg = palette.length > 2 && palette[0] === '#FFFFFF' ? '#FFFFFF'
    : ['#0D1117', '#1A1A1A', '#F5F1E8', '#FAF9F7'].includes(palette[0]) ? palette[0]
    : /^#(F|f|E|e|D|d)/.test(palette[0] ?? '') ? palette[0] : palette[0] ?? '#FFFFFF';
  const isDark = (() => {
    const c = palette[0] ?? '#FFFFFF';
    const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 < 128;
  })();
  const textColor = isDark ? '#F5F5F5' : '#1A1A1A';
  const mutedColor = isDark ? '#9CA3AF' : '#6B7280';
  // 强调色：跳过背景色后的第一个饱和色
  const accent = palette.slice(1).find((c) => {
    const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return (mx - mn) > 40; // 有饱和度
  }) ?? palette[1] ?? (isDark ? '#60A5FA' : '#C0392B');
  const cardFill = isDark ? 'rgba(255,255,255,0.06)' : '#F9FAFB';
  const cardStroke = isDark ? 'rgba(255,255,255,0.12)' : '#E5E7EB';

  const shortName = name.length > 14 ? name.slice(0, 13) + '…' : name;
  const typLine = (style.typography ?? '').slice(0, 28);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="${bg}"/>
  <!-- 顶部标题区（模板示意封面） -->
  <rect x="80" y="96" width="86" height="10" rx="5" fill="${accent}"/>
  <text x="80" y="185" font-family="'Microsoft YaHei', sans-serif" font-size="58" font-weight="bold" fill="${textColor}">${esc(shortName)}</text>
  <text x="80" y="238" font-family="'Microsoft YaHei', sans-serif" font-size="22" fill="${mutedColor}">${esc(style.mode || 'custom')} · ${esc(typLine)}</text>
  <!-- 字阶示意 -->
  <text x="80" y="330" font-family="'Microsoft YaHei', sans-serif" font-size="30" font-weight="bold" fill="${textColor}">标题字阶 30pt</text>
  <text x="80" y="372" font-family="'Microsoft YaHei', sans-serif" font-size="20" fill="${textColor}">小节标题 20pt</text>
  <text x="80" y="408" font-family="'Microsoft YaHei', sans-serif" font-size="16" fill="${mutedColor}">正文内容 16pt，示例段落文字用于展示字阶层级。</text>
  <!-- 卡片布局示意 -->
  <g>
    <rect x="80" y="452" width="356" height="170" rx="12" fill="${cardFill}" stroke="${cardStroke}"/>
    <rect x="104" y="478" width="52" height="6" rx="3" fill="${accent}"/>
    <rect x="104" y="500" width="220" height="12" rx="6" fill="${textColor}" opacity="0.8"/>
    <rect x="104" y="524" width="280" height="8" rx="4" fill="${mutedColor}" opacity="0.5"/>
    <rect x="104" y="542" width="240" height="8" rx="4" fill="${mutedColor}" opacity="0.35"/>
  </g>
  <g>
    <rect x="462" y="452" width="356" height="170" rx="12" fill="${cardFill}" stroke="${cardStroke}"/>
    <rect x="486" y="478" width="52" height="6" rx="3" fill="${accent}"/>
    <rect x="486" y="500" width="200" height="12" rx="6" fill="${textColor}" opacity="0.8"/>
    <rect x="486" y="524" width="270" height="8" rx="4" fill="${mutedColor}" opacity="0.5"/>
    <rect x="486" y="542" width="230" height="8" rx="4" fill="${mutedColor}" opacity="0.35"/>
  </g>
  <g>
    <rect x="844" y="452" width="356" height="170" rx="12" fill="${cardFill}" stroke="${cardStroke}"/>
    <rect x="868" y="478" width="52" height="6" rx="3" fill="${accent}"/>
    <rect x="868" y="500" width="230" height="12" rx="6" fill="${textColor}" opacity="0.8"/>
    <rect x="868" y="524" width="260" height="8" rx="4" fill="${mutedColor}" opacity="0.5"/>
    <rect x="868" y="542" width="250" height="8" rx="4" fill="${mutedColor}" opacity="0.35"/>
  </g>
  <!-- 色板条 -->
  ${palette.slice(0, 6).map((c, i) => `<rect x="${80 + i * 34}" y="668" width="26" height="26" rx="6" fill="${c}" stroke="rgba(128,128,128,0.3)"/>`).join('\n  ')}
  <text x="${80 + Math.min(palette.length, 6) * 34 + 14}" y="687" font-family="monospace" font-size="15" fill="${mutedColor}">${palette.slice(0, 4).join(' ')}</text>
</svg>`;
}
