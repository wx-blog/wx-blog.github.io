/**
 * 站点级配置。改这里就能改全站文案，不用翻页面。
 *
 * ⚠️ 部署前必改：SITE.url、SITE.social
 */
export const SITE = {
  /** 站点名，出现在浏览器标题和页头 */
  title: '知行笔记',
  /** 副标题 / tagline */
  tagline: '把踩过的坑写下来',
  /** 默认 meta description */
  description:
    '张炜轩的技术笔记：Linux 与运维、Kubernetes 与混沌工程实验记录，以及学习过程中的踩坑复盘。',
  author: '张炜轩',
  /** <html lang> */
  lang: 'zh-CN',

  /**
   * 站点根地址。必须与 astro.config.mjs 的 site 完全一致。
   *
   * 当前 = GitHub Pages 用户主页仓库地址（用户名 weixuannote）。
   * 用户主页仓库的网址就是 https://<username>.github.io，结尾不带路径、不带斜杠。
   */
  url: 'https://weixuannote.github.io',

  /** 页头导航 */
  nav: [
    { label: '文章', href: '/blog/' },
    { label: '标签', href: '/tags/' },
    { label: '关于', href: '/about/' },
  ],

  /** 页脚外链，直接把不需要的删掉 */
  social: [
    { label: 'GitHub', href: 'https://github.com/weixuannote' },
    { label: 'RSS', href: '/rss.xml' },
  ],

  /** 首页每页文章数 */
  postsPerPage: 20,
};

/** 每页文章数（首页） */
export const POSTS_PER_PAGE = SITE.postsPerPage;
