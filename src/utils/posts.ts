import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

/**
 * 文章的完整发布时间（毫秒）。
 *
 * `pubDate` 只到天，同日多篇会完全相等；`pubTime`（可选）补上时分。
 * 两者合成一个时间戳，排序才真正可用。
 */
export function postTimestamp(post: Post): number {
  const base = post.data.pubDate.valueOf();
  const time = post.data.pubTime;
  if (!time) return base;
  const [h, m] = time.split(':').map(Number);
  return base + (h * 60 + m) * 60_000;
}

/** 取全部已发布文章，按发布时间倒序（同时间再按 id 倒序，保证结果稳定） */
export async function getPublishedPosts(): Promise<Post[]> {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts.sort(
    (a, b) => postTimestamp(b) - postTimestamp(a) || b.id.localeCompare(a.id),
  );
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
 * 卡片摘要：在标点处收尾，而不是让 CSS 从字中间切一刀。
 *
 * 中文没有空格，`line-clamp` 截断会停在任意一个字上（「…插件的」然后省略），
 * 读起来像断气。这里先在预算长度内找句末标点，退而求其次找逗号，
 * 让省略号落在语义停顿处。找不到合适位置才硬截。
 */
export function cardExcerpt(text = '', max = 76): string {
  const s = text.trim();
  if (s.length <= max) return s;

  const head = s.slice(0, max);
  let sentenceEnd = -1;
  for (const p of ['。', '！', '？', '；']) {
    sentenceEnd = Math.max(sentenceEnd, head.lastIndexOf(p));
  }
  if (sentenceEnd >= max * 0.55) return head.slice(0, sentenceEnd + 1);

  const comma = Math.max(head.lastIndexOf('，'), head.lastIndexOf(','));
  if (comma >= max * 0.55) return `${head.slice(0, comma)}…`;

  return `${head.replace(/[，、,;；\s]+$/, '')}…`;
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
