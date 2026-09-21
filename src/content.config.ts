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
    /** 最后修改日期，可选 */
    updatedDate: z.coerce.date().optional(),
    /** 标签，别写太多，超过 5 个基本等于没分类 */
    tags: z.array(z.string()).default([]),
    /** 草稿：true 时不会出现在任何列表、标签页和 RSS 中 */
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
