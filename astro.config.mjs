// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import remarkCjkSpacing from './remark-cjk-spacing.mjs';

/**
 * 站点根地址，canonical / RSS / sitemap 都依赖它。
 *
 * 当前值 = GitHub Pages 用户主页仓库地址（用户名 wx-blog）。
 * 必须与 src/consts.ts 的 SITE.url 保持一致。
 *
 * 用户主页仓库（<username>.github.io）：https://<username>.github.io
 * 项目仓库（<username>/<repo>）：https://<username>.github.io/<repo> → 还要加 base: '/<repo>'
 */
const SITE_URL = 'https://wx-blog.github.io';

// https://astro.build/config
export default defineConfig({
  site: SITE_URL,

  // 生成 /blog/post/ 这种带尾斜杠的目录式 URL，GitHub Pages 上更稳
  trailingSlash: 'always',

  markdown: {
    // Astro 7 默认换成了 Sätteri 处理器，它不支持 remark 插件；
    // 这里显式用回 unified，好挂自己的中文折行处理（见 remark-cjk-spacing.mjs）
    processor: unified({
      remarkPlugins: [remarkCjkSpacing],
    }),
    shikiConfig: {
      // 亮/暗双主题，配合 global.css 里的 .astro-code 规则切换
      themes: {
        light: 'github-light',
        dark: 'github-dark-dimmed',
      },
      wrap: false,
    },
  },

  integrations: [sitemap()],
});
