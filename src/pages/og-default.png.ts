import type { APIRoute } from 'astro';
import sharp from 'sharp';
import { SITE } from '../consts';
import { ogSvg } from '../utils/og';

/**
 * 站点默认分享图。和文章图共用同一套模板与配色，
 * 首页、标签页、搜索页等没有专属图的页面用它。
 */
export const GET: APIRoute = async () => {
  const svg = ogSvg({
    title: SITE.tagline,
    eyebrow: `${SITE.title} · 技术笔记`,
    meta: 'Linux · 存储 · 网络 · 容器与自动化',
  });

  const png = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, palette: true, colours: 256, dither: 0.8 })
    .toBuffer();

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
    },
  });
};
