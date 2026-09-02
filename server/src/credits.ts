/**
 * PPTByBy 积分定价
 *  - PPT 生成：按页扣，1 积分 / 页
 *  - AI 生图：每张额外 1 积分
 *  - 预扣 = 大纲页数 × 1 + 预计生图数 × 1，完成后按实际产出结算，多退少补
 */

export const CREDITS_PER_PAGE = 1;
export const CREDITS_PER_IMAGE = 1;

export interface PptQuote {
  pages: number;
  images: number;
  total: number;
}

/** 生成前预估报价 */
export function quoteTask(pages: number, images = 0): PptQuote {
  const p = Math.max(1, Math.floor(pages));
  const i = Math.max(0, Math.floor(images));
  return { pages: p, images: i, total: p * CREDITS_PER_PAGE + i * CREDITS_PER_IMAGE };
}
