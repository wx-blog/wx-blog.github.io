import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { SITE } from '../consts';
import { getPublishedPosts, postUrl } from '../utils/posts';

/**
 * 纯 RSS 2.0，不再套 XSLT 样式表。
 *
 * 之前为了让浏览器直接打开 /rss.xml 时不至于满屏 XML，注入过
 * `<?xml-stylesheet?>` 指向 public/rss.xsl。这条路已经走不通：
 * Chrome 158（2026-11-17）移除了 XSLT，Firefox / WebKit 也在跟进，
 * 留着只会得到一个"在新浏览器里失效、在旧浏览器里多加载一份 XSL"的页面。
 *
 * 现在把「人看的订阅说明」做成真正的 /subscribe/ 页面，
 * /rss.xml 只服务阅读器。
 */
export async function GET(context: APIContext) {
  const posts = await getPublishedPosts();

  return rss({
    title: SITE.title,
    description: SITE.description,
    site: context.site ?? SITE.url,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: postUrl(post.id),
      categories: post.data.tags,
    })),
    customData: `<language>${SITE.lang}</language>`,
  });
}
