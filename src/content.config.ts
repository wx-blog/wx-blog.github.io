import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
  // Content Layer API：从 src/content/blog 下收集所有 .md
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    /** 文章标题 */
    title: z.string().max(120),
    /** 摘要，用于列表页、SEO 与 RSS */
    description: z.string().default(''),
    /** 发布日期，支持 `2026-09-18` 或完整 ISO 时间 */
    pubDate: z.coerce.date(),
    /**
     * 同一天内的发布时间，格式 `HH:mm`，可选。
     *
     * 为什么单独留这个字段：很多文章是批量导入的，`pubDate` 只到天，
     * 同一天的多篇文章在排序里完全等价（比较结果恒为 0），
     * 最终顺序会退化成文件系统顺序（近似字母序），
     * 「最新文章」于是名不副实。填上 `pubTime` 就能精确控制先后。
     *
     * 写法：`pubTime: '21:30'`
     */
    pubTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'pubTime 必须是 HH:mm 格式，例如 21:30')
      .optional(),
    /** 最后修改日期，可选 */
    updatedDate: z.coerce.date().optional(),
    /** 标签，别写太多：全站标签控制在十几个以内，否则每个标签只剩一两篇 */
    tags: z.array(z.string()).default([]),
    /** 草稿：true 时不会出现在任何列表、标签页和 RSS 中 */
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
