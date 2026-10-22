import type { APIRoute, GetStaticPaths } from 'astro';
import sharp from 'sharp';
import { SITE } from '../../consts';
import { ogSvg } from '../../utils/og';
import { getPublishedPosts, type Post } from '../../utils/posts';

/**
 * 每篇文章一张分享图，构建期生成 /og/<id>.png。
 *
 * 为什么放在端点里而不是 public/：
 * 标题、标签都来自 content collection，端点能直接拿到，
 * 不用再写一个解析 frontmatter 的脚本去维护第二套数据源。
 */
export const getStaticPaths = (async () => {
  const posts = await getPublishedPosts();
  return posts.map((post) => ({
    params: { id: post.id },
    props: { post },
  }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props }) => {
  const { post } = props as { post: Post };
  const meta = post.data.tags.slice(0, 3).join(' · ') || '技术笔记';

  const svg = ogSvg({
    title: post.data.title,
    eyebrow: `${SITE.title} · 技术笔记`,
    meta,
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
