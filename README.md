# 知行笔记

个人技术博客。Astro 7 构建，纯静态输出。

写作方向：Linux 与运维、Kubernetes 与混沌工程、虚拟化，以及学习过程中的踩坑复盘。

---

## 快速开始

```bash
npm install      # 安装依赖
npm run dev      # 本地开发，http://localhost:4321
npm run build    # 构建到 dist/（会先跑字体子集化）
npm run preview  # 预览构建结果
```

国内网络建议先切镜像源，能快很多：

```bash
npm config set registry https://registry.npmmirror.com
```

## 这套视觉是怎么做出来的

三个不太常见、但决定了「看起来贵不贵」的点，改之前建议先读一下。

### 1. 中文字体是子集化的，不是整包上传

思源黑体全字库 **17MB**。就算按 Google Fonts 那样切成 100 多个 `unicode-range` 分片，
打开一页仍要拉 2MB 左右，首屏基本废掉。

这里的做法是构建时**按站点实际用字裁剪**：

```bash
npm run fonts    # 手动跑；npm run build 会自动先跑
```

`scripts/subset-fonts.mjs` 会扫 `src/` 下所有源码和文章，抽出真正出现的字符，
用 harfbuzz（wasm，无需本地编译）切出一个 woff2。实测：

```
16.95MB  →  ~340KB（压缩 98%）
```

因为挂在 `build` 前面，**子集永远和内容同步**，不会出现「新文章某个字没有字形」。
子集需要完整的可变字体源文件，放在 `.font-src/`，首次构建会自动下载（17MB，只下一次），
该目录和产物 `public/fonts/` 都已加入 `.gitignore`。

拉丁字形单独用 Inter 的 `latin` 分片（约 47KB），两个文件都在本地托管，
不依赖任何第三方字体 CDN。

### 2. 封面图是代码算出来的

`src/components/Cover.astro`。按文章 ID 做 FNV-1a 哈希，从 **6 套配色 × 6 种构图**
里确定性地选一套，输出内联 SVG。

- 同一篇文章永远得到同一张图，文章增删、顺序变化都不会让封面跳变
- 零素材、零版权、零额外请求，构建时瞬时生成
- 想调色板就改 `Cover.astro` 里的 `INKS`；想调构图就改下面的 `variant` 分支

**画布是 1200 单位宽，而封面在页面上通常只有 400px 左右**——所以描边要按
`3~5` 这个量级给，写 `1.5` 会缩成 0.5px，等于看不见。

### 3. 中文折行不会留下多余空格

Markdown 里段落内的换行会被当成空格。中文段落一旦按行折行，渲染出来就是
「中 文 出 现 空 格」。`remark-cjk-spacing.mjs` 会在纯文本节点里清掉
「中日韩字符 + 空白 + 中日韩字符」中的空白：

- 行内代码、代码块不受影响
- 中英文之间的空格**保留**（`订阅 RSS` 这种是有意加的）

因为 Astro 7 的默认 Markdown 处理器 Sätteri 不支持 remark 插件，
`astro.config.mjs` 里显式指定了 `processor: unified({ remarkPlugins: [...] })`
（依赖 `@astrojs/markdown-remark`）。Shiki 高亮照常工作。

> 顺带一条约定：`.astro` 模板里的中文句子**写在一行里**，别在句中换行——
> 上面那个插件只管 Markdown，管不到模板。

## 目录结构

```text
.
├── astro.config.mjs            # 站点地址、markdown 处理器、Shiki、sitemap
├── remark-cjk-spacing.mjs      # 中文折行处理插件
├── src/
│   ├── consts.ts               # ⭐ 站点名、导航、社交链接、描述
│   ├── content.config.ts       # 文章 frontmatter 的 schema 校验
│   ├── content/blog/           # ⭐ 文章 Markdown 都放这里
│   ├── styles/
│   │   ├── global.css          # 全站样式，设计令牌集中在 :root
│   │   └── fonts.css           # @font-face，指向 public/fonts 下的子集
│   ├── layouts/BaseLayout.astro
│   ├── components/
│   │   ├── Cover.astro         # ⭐ 程序化封面
│   │   ├── PostCard.astro      # 文章卡片
│   │   ├── PostList.astro      # 卡片网格，首页/归档/标签页共用
│   │   ├── Header.astro
│   │   ├── Footer.astro
│   │   └── ThemeToggle.astro
│   ├── utils/posts.ts          # 取文章、排序、标签聚合、阅读时长
│   └── pages/
│       ├── index.astro              # /
│       ├── about.astro              # /about/
│       ├── rss.xml.ts               # /rss.xml
│       ├── blog/index.astro         # /blog/  全部文章（按年分组）
│       ├── blog/[...id].astro       # /blog/<文件名>/  带右侧目录
│       ├── tags/index.astro         # /tags/
│       └── tags/[tag].astro         # /tags/<标签>/
├── scripts/
│   ├── subset-fonts.mjs        # 中文字体子集化
│   ├── make-og.py              # 生成分享图（一次性，产物已提交）
│   └── new-post.mjs            # 新建文章脚手架
├── public/
│   ├── fonts/                  # 字体子集产物（gitignore，构建时生成）
│   ├── og-default.png          # 社交分享图 1200×630
│   └── favicon.svg
└── .github/workflows/deploy.yml
```

## 写一篇新文章

```bash
npm run new -- "文章标题"
```

会在 `src/content/blog/` 下生成 `YYYY-MM-DD-<slug>.md`，frontmatter 已经填好。
默认 `draft: true`，**不会出现在站点上**，写完后改成 `false` 才会发布。

### frontmatter 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | 文章标题 |
| `description` | | 摘要，列表页、SEO、RSS 都会用 |
| `pubDate` | ✅ | 支持 `2026-09-18` 或完整 ISO 时间 |
| `updatedDate` | | 有修订时填，文章页会多显示一行 |
| `tags` | | 字符串数组，建议不超过 5 个 |
| `draft` | | `true` 时不发布，默认 `false` |

URL 就是文件名去掉 `.md`，所以文件名一旦定下来**尽量别改**，否则旧链接会失效。

### 排版约定

- 标题层级从 `##` 开始用（`#` 是文章标题，正文里不要出现）
- 目录只收 `##` 和 `###` 两级
- 段内不要手动换行，写成一整行（折行交给渲染层）
- 表格、代码块、引用都按标准 Markdown 写就行

## 部署

默认走 GitHub Pages，`.github/workflows/deploy.yml` 已经写好。

### 1. 改站点地址（必做）

两处必须一致：

- `astro.config.mjs` 的 `site`
- `src/consts.ts` 的 `SITE.url`

| 仓库类型 | 地址格式 |
| --- | --- |
| 用户主页仓库 `<username>.github.io` | `https://<username>.github.io` |
| 普通项目仓库 `<username>/<repo>` | `https://<username>.github.io/<repo>` |

如果是**项目仓库**，还要在 `astro.config.mjs` 里补一行 `base: '/<repo>'`。

> 注意：`src/styles/fonts.css` 里的字体路径写的是绝对路径 `/fonts/...`。
> 如果部署到子路径（项目仓库），需要把这两条 `url()` 也带上子路径。

### 2. 推到 GitHub

```bash
git init
git add .
git commit -m "chore: 初始化博客"
git branch -M main
git remote add origin git@github.com:<username>/<repo>.git
git push -u origin main
```

### 3. 打开 Pages

仓库 → **Settings** → **Pages** → **Build and deployment** → Source 选 **GitHub Actions**。

### 4. 换成你自己的网址（自定义域名）

先明确一件事：**WorkBuddy 托管分配的 `zhixing-notes.app.workbuddy.host` 改不成你自己的域名。**
那个地址由平台生成，只有「应用名 + 平台域名」这一种形式。想用自己的网址，必须把站搬到
你能控制域名的位置——最省事的是 GitHub Pages（免费、自带仓库备份、可直接绑域名）。

按投入从少到多，三种「自己的网址」：

| 你想要的地址 | 需要做什么 | 花费 |
| --- | --- | --- |
| `<username>.github.io` | 注册 GitHub、建仓库、推上去 | 0 |
| `blog.example.com` | 上面的 + 买域名 + 1 条 CNAME 记录 | 域名费 |
| `example.com` | 上面的 + 4 条 A + 4 条 AAAA + www 的 CNAME | 域名费 |

#### 要花多少钱

除域名之外全部免费：GitHub Pages 托管免费，HTTPS 证书由 GitHub 自动签发，
指向海外解析**不需要备案**。

域名（2026-09 实测，腾讯云标准价 / 阿里云同档）：

| 后缀 | 首年 | 续费（每年） |
| --- | --- | --- |
| `.com` | ¥83 | ¥90 |
| `.cn` | ¥33 | ¥38 |
| `.vip` | ¥32 | ¥41 |
| `.top` | ¥14 | ¥34 |

> **只看续费价，别看首年价。** 首年 ¥1 那批后缀是引流价，续费能翻十几倍——
> `.xyz` 首年 ¥15 → 续费 ¥106，`.cloud` 首年 ¥12 → 续费 ¥280。
> `.com` / `.cn` 这种「首年不便宜、续费也不涨」的反而最省心。
> 腾讯云新客能把 `.com` / `.cn` 做到 0 元首年，但**通常要求 2 年起购**，要比总价不能比首年。

所以真实成本是：**第一年 ¥83，之后每年 ¥90**。`.cn` 减半，但通用性不如 `.com`。


#### 第一步：改站点地址

换成自己的网址后必须先改这两处，否则 canonical、RSS、sitemap 里全是旧地址：

- `astro.config.mjs` 的 `SITE_URL`
- `src/consts.ts` 的 `SITE.url`

两处保持完全一致。用的是主域名就填 `https://example.com`（结尾不带斜杠）。

#### 第二步：配 DNS

**主域名（`example.com` 这种）**——以下记录全部要加：

| 类型 | 主机记录 | 值 |
| --- | --- | --- |
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| AAAA | `@` | `2606:50c0:8000::153` |
| AAAA | `@` | `2606:50c0:8001::153` |
| AAAA | `@` | `2606:50c0:8002::153` |
| AAAA | `@` | `2606:50c0:8003::153` |
| CNAME | `www` | `<username>.github.io` |

**子域名（`blog.example.com` 这种）**——只要一条：

| 类型 | 主机记录 | 值 |
| --- | --- | --- |
| CNAME | `blog` | `<username>.github.io` |

> CNAME 的值只能填 `<username>.github.io`，**不要带仓库名**，也不要填 GitHub 给的
> `*.pages.github.io` 那种临时域名。

#### 第三步：在 GitHub 上登记域名

仓库 → **Settings** → **Pages** → **Custom domain** 填域名 → **Save**。
等 DNS 生效、证书签发完（最多 24 小时），回来勾上 **Enforce HTTPS**。

> 本项目走的是自定义 Actions workflow 部署。这种情况 GitHub **不需要、也不读取
> `public/CNAME` 文件**，域名记在仓库设置里。所以不用往 `public/` 放 CNAME。
> 哪天改成「从分支直接发布」，才必须加那个文件。

#### 两个坑

- **别用通配符记录**（`*.example.com`）。`a.example.com` 被验证过不代表 `b.a.example.com`
  安全，通配符会直接把其余子域暴露给域名劫持。
- 主域名和 `www` 两条都配上，GitHub Pages 会自动做互相跳转；只配一条时另一条的 HTTPS
  经常签不下来。

## 定制入口

| 想改什么 | 去哪里 |
| --- | --- |
| 站点名、导航、社交链接、描述 | `src/consts.ts` |
| 配色、字号阶梯、间距、圆角 | `src/styles/global.css` 顶部的 `:root` |
| 封面配色 / 构图 | `src/components/Cover.astro` 的 `INKS` 与 `variant` 分支 |
| 代码高亮主题 | `astro.config.mjs` 的 `markdown.shikiConfig.themes` |
| 分享图 | `python scripts/make-og.py`（需 Python + Pillow） |
| favicon | `public/favicon.svg` |

### 换成自己的内容

站刚建好时带了三篇示例文章（`src/content/blog/` 下的三个 `.md`），是用来撑版式的骨架，
**发之前记得删掉或改写**。换成自己的东西只需要动三个地方：

| 想改什么 | 去哪里 |
| --- | --- |
| 站点名 / 副标题 / 作者 / 描述 | `src/consts.ts` |
| 导航项、页脚外链 | `src/consts.ts` 的 `nav` 与 `social` |
| 关于页全文 | `src/pages/about.astro` |

### 待补

- `src/consts.ts` 里的 GitHub 链接目前是 `https://github.com/` 占位，换成自己的主页
- 三篇示例文章换成自己的真实笔记

## 许可

文章内容采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh)；
站点代码可自由取用。字体为思源黑体（SIL OFL 1.1）与 Inter（SIL OFL 1.1），均可商用。
