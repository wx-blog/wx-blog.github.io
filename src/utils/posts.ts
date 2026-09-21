import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

/** 取全部已发布文章，按时间倒序 */
export async function getPublishedPosts(): Promise<Post[]> {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** 文章永久链接 */
export function postUrl(id: string): string {
  return `/blog/${id}/`;
}

/** 标签页链接 */
export function tagUrl(tag: string): string {
  return `/tags/${encodeURIComponent(tag)}/`;
}

/** YYYY-MM-DD */
export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** ISO 字符串，给 <time datetime> 用 */
export function isoDate(date: Date): string {
  return date.toISOString();
}

/**
 * 粗估阅读时长（分钟）。
 *
 * 三种内容分开算，因为读它们的速度差得很远：
 *   · 中文 350 字/分  · 英文 200 词/分  · 代码 900 字符/分
 *
 * 代码块不能整块剔掉——速查类文章正文很少、代码很多，剔掉之后会算出「约 1 分钟」，
 * 与实际读到的东西完全不符。按上面的速率折算一下才靠谱。
 */
export function readingTime(body = ''): number {
  const codeChars = (body.match(/```[\s\S]*?```/g) ?? [])
    .join('')
    .replace(/```[a-zA-Z0-9-]*/g, '').length;

  const text = body
    .replace(/```[\s\S]*?```/g, '') // 去掉代码块（上面已单独计入）
    .replace(/`[^`]*`/g, '') // 去掉行内代码
    .replace(/<[^>]+>/g, '') // 去掉 HTML 标签
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ''); // 去掉链接与图片

  const cjkPattern = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
  const cjk = (text.match(cjkPattern) ?? []).length;
  const words = (text.replace(cjkPattern, ' ').match(/[A-Za-z0-9]+/g) ?? []).length;

  return Math.max(1, Math.round(cjk / 350 + words / 200 + codeChars / 900));
}

/**
 * 每篇文章的稳定技术编号，用在封面角标与文章页元信息里。
 *
 * FNV-1a 取哈希前 6 位十六进制——和 Cover.astro 找配色用的是同一套哈希思路，
 * 所以同一篇文章的编号和封面永远对得上；增删文章、改标题都不会让编号串位。
 */
export function postCode(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0)
    .toString(16)
    .toUpperCase()
    .padStart(8, '0')
    .slice(0, 6);
}

/** 标签 -> 篇数，按篇数倒序 */
export function collectTags(posts: Post[]): Array<[string, number]> {
  const counter = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      counter.set(tag, (counter.get(tag) ?? 0) + 1);
    }
  }
  return [...counter.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
}

/** 按年份分组，保持传入顺序 */
export function groupByYear(posts: Post[]): Array<[string, Post[]]> {
  const groups = new Map<string, Post[]>();
  for (const post of posts) {
    const year = String(post.data.pubDate.getFullYear());
    const bucket = groups.get(year);
    if (bucket) bucket.push(post);
    else groups.set(year, [post]);
  }
  return [...groups.entries()].sort((a, b) => Number(b[0]) - Number(a[0]));
}

/** 取某篇文章的前后邻居（传入的必须是已按时间倒序排列的数组） */
export function getNeighbors(
  posts: Post[],
  id: string,
): { newer?: Post; older?: Post } {
  const index = posts.findIndex((p) => p.id === id);
  if (index === -1) return {};
  // 列表倒序：索引更小 = 更新，索引更大 = 更早
  return { newer: posts[index - 1], older: posts[index + 1] };
}
