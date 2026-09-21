/**
 * 新建文章：npm run new -- "文章标题" [slug]
 *
 * 会在 src/content/blog/ 下生成 YYYY-MM-DD-slug.md，自动填好 frontmatter。
 * slug 省略时用日期当文件名。
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const postsDir = join(root, 'src', 'content', 'blog');

const [, , ...args] = process.argv;
const title = args.filter((a) => !a.startsWith('--')).join(' ').trim();

if (!title) {
  console.error('用法: npm run new -- "文章标题" [slug]');
  console.error('示例: npm run new -- "Proxmox VE 集群搭建笔记" proxmox-cluster');
  process.exit(1);
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

const explicitSlug = args.find((a) => a.startsWith('--slug='))?.slice('--slug='.length);
const slug =
  explicitSlug ||
  title
    .toLowerCase()
    .replace(/[\u4e00-\u9fff]/g, '') // 中文不进文件名，留给你自己补
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') ||
  'post';

const fileName = `${date}-${slug}.md`;
const filePath = join(postsDir, fileName);

const today = `${date}T${pad(now.getHours())}:${pad(now.getMinutes())}:00+08:00`;

const template = `---
title: ${title}
description: 一句话说清这篇解决什么问题。
pubDate: ${today}
tags: []
draft: true
---

正文从这里开始。

## 小标题

\`\`\`bash
echo "命令能跑通再贴上来"
\`\`\`
`;

try {
  await access(filePath);
  console.error(`已存在，换个 slug：${fileName}`);
  process.exit(1);
} catch {
  /* 文件不存在，继续 */
}

await mkdir(postsDir, { recursive: true });
await writeFile(filePath, template, 'utf8');

console.log(`已创建 ${fileName}`);
console.log(`路径 ${filePath}`);
console.log('提示：draft: true 不会出现在站点上，写完了记得改成 false。');
