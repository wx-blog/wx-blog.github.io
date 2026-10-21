import type { APIRoute } from 'astro';
import { formatDate, getPublishedPosts, postUrl, readingTime } from '../utils/posts';

/**
 * 站内搜索索引。构建期生成一个静态 JSON，前端按需拉取。
 *
 * 为什么不在构建时把索引直接塞进搜索页的 HTML：
 * 全文索引大约几百 KB，而绝大多数访客不会用搜索。做成独立文件，
 * 只有真正打开 /search/ 并开始输入时才下载，首屏零成本。
 */

/** 把 Markdown 正文压成适合检索的纯文本，保留代码里的标识符 */
function plainText(body: string): string {
  return body
    .replace(/```[a-zA-Z0-9-]*\n?/g, ' ') // 围栏标记，保留代码内容
    .replace(/`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接留文字
    .replace(/<[^>]+>/g, ' ') // HTML
    .replace(/^\s{0,3}#{1,6}\s+/gm, ' ') // 标题记号
    .replace(/^\s{0,3}>\s?/gm, ' ') // 引用
    .replace(/^\s{0,3}[-*+]\s+/gm, ' ') // 列表
    .replace(/^\s{0,3}\d+\.\s+/gm, ' ')
    .replace(/[*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

export const GET: APIRoute = async () => {
  const posts = await getPublishedPosts();

  const index = posts.map((post) => ({
    title: post.data.title,
    description: post.data.description,
    tags: post.data.tags,
    date: formatDate(post.data.pubDate),
    minutes: readingTime(post.body),
    url: postUrl(post.id),
    text: plainText(post.body),
  }));

  return new Response(JSON.stringify(index), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
};
