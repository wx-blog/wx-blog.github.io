/**
 * 站点级配置。改这里就能改全站文案，不用翻页面。
 *
 * ⚠️ 部署前必改：SITE.url、SITE.social
 */
export const SITE = {
  /** 站点名，出现在浏览器标题和页头 */
  title: '炜轩的blog',
  /** 副标题 / tagline */
  tagline: '把踩过的坑写下来',
  /** 默认 meta description */
  description:
    '张炜轩的技术笔记：Linux 与云计算方向的实验记录，以及备考、毕设和大创路上的一些复盘。',
  author: '张炜轩',
  /** <html lang> */
  lang: 'zh-CN',

  /**
   * 站点根地址。必须与 astro.config.mjs 的 site 完全一致。
   *
   * 当前 = GitHub Pages 用户主页仓库地址（用户名 wx-blog）。
   * 用户主页仓库的网址就是 https://<username>.github.io，结尾不带路径、不带斜杠。
   */
  url: 'https://wx-blog.github.io',

  /** 页头导航。窄屏放不下第 4 项，所以「关于」「搜索」放在页脚。 */
  nav: [
    { label: '开始', href: '/start/' },
    { label: '文章', href: '/blog/' },
    { label: '标签', href: '/tags/' },
  ],

  /** 页脚站点内链接（与下方外链分开，避免「关于」出现在社交一栏里） */
  footerLinks: [
    { label: '关于', href: '/about/' },
    { label: '搜索', href: '/search/' },
    { label: '订阅', href: '/subscribe/' },
  ],

  /** 页脚外链，直接把不需要的删掉 */
  social: [{ label: 'GitHub', href: 'https://github.com/wx-blog' }],

  /** 首页每页文章数 */
  postsPerPage: 20,
};

/** 每页文章数（首页） */
export const POSTS_PER_PAGE = SITE.postsPerPage;
