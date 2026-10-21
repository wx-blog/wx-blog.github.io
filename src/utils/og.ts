/**
 * 分享图（og:image）的 SVG 模板。
 *
 * 构建期由 /og/[id].png 与 /og-default.png 两个端点转成 PNG，
 * 所以文章标题、日期、标签都能真实出现在分享卡上，而不是 35 篇共用一张图。
 *
 * 几条约束：
 *  · 只用 librsvg 稳定支持的能力（线性/径向渐变、基础图形、text），不用 filter；
 *  · 文字不换行交给 CSS，而是自己量宽度断行——SVG 里没有 line-clamp；
 *  · 字体在 CI 上靠 fonts-noto-cjk，在 Windows 本地靠微软雅黑，两套都写进 font-family。
 */

const W = 1200;
const H = 630;

const FONT =
  "'Noto Sans CJK SC', 'Noto Sans SC', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', sans-serif";
const MONO = "'JetBrains Mono', 'Cascadia Mono', Consolas, 'Noto Sans Mono CJK SC', monospace";

interface OgOptions {
  /** 主标题，一般是文章标题 */
  title: string;
  /** 左上角小字，默认由调用方传入站点名 */
  eyebrow?: string;
  /** 底部左侧信息（日期 · 标签） */
  meta?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 粗略字宽：全角字符按 1em，西文按 0.56em，空格按 0.3em */
function measure(text: string, size: number): number {
  let width = 0;
  for (const ch of text) {
    if (/[\u3000-\u303f\uff01-\uff60\u3400-\u9fff\uf900-\ufaff]/.test(ch)) width += size;
    else if (/\s/.test(ch)) width += size * 0.3;
    else width += size * 0.56;
  }
  return width;
}

/** 把西文单词当作整体，中文逐字成 token，断行才不会把 "firewalld" 切成两半 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = '';
  for (const ch of text) {
    if (/[A-Za-z0-9._+\-#/:%@&]/.test(ch)) {
      word += ch;
      continue;
    }
    if (word) {
      tokens.push(word);
      word = '';
    }
    tokens.push(ch);
  }
  if (word) tokens.push(word);
  return tokens;
}

const CLOSING = /^[。，、；：！？）》」』”’…,.;:!?)\]}%]$/;

/**
 * 按标点/空格切「词组」：中文没有词边界，逐字断行会得到「本地编 / 译」；
 * 标点天然就是停顿点，把标点连同前面的字绑在一起，换行机会就落在这些地方。
 * 例如「本地编译、交叉编译与鲲鹏专用编译器」会切成
 * 「本地编译、」+「交叉编译与鲲鹏专用编译器」。
 */
function cluster(text: string): string[] {
  const parts: string[] = [];
  let buf = '';
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (buf) {
        parts.push(buf);
        buf = '';
      }
      parts.push(' ');
      continue;
    }
    buf += ch;
    if (CLOSING.test(ch)) {
      parts.push(buf);
      buf = '';
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

function wrap(text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  let width = 0;

  const append = (token: string) => {
    line += token;
    width += measure(token, size);
  };
  const flush = () => {
    if (line.trim()) lines.push(line.trimEnd());
    line = '';
    width = 0;
  };

  for (const part of cluster(text)) {
    if (part === ' ') {
      if (line && width + size * 0.3 <= maxWidth) append(' ');
      continue;
    }

    const partWidth = measure(part, size);
    if (width + partWidth > maxWidth && line) flush();

    if (partWidth > maxWidth) {
      // 一整段都没有标点、又比一行还长：只能退回逐字拆，保证不出画布
      for (const token of tokenize(part)) {
        const tokenWidth = measure(token, size);
        if (width + tokenWidth > maxWidth && line) flush();
        append(token);
      }
    } else {
      append(part);
    }
  }

  flush();
  return lines;
}

function ellipsize(text: string, size: number, maxWidth: number): string {
  if (measure(text, size) <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && measure(`${result}…`, size) > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}…`;
}

function fitTitle(title: string): { size: number; lines: string[] } {
  const initial = title.length <= 12 ? 82 : title.length <= 22 ? 72 : title.length <= 34 ? 62 : 54;
  const maxWidth = 1010;
  // 为了两行而最多缩 8px；再小就宁可排三行，字号不能没有下限
  const floor = Math.max(42, initial - 8);

  let fallback: { size: number; lines: string[] } | null = null;

  for (let size = initial; size >= 42; size -= 4) {
    const lines = wrap(title, size, maxWidth);
    if (lines.length <= 2 && size >= floor) return { size, lines };
    if (!fallback && lines.length <= 3) fallback = { size, lines };
  }

  if (fallback) return fallback;

  const lines = wrap(title, 42, maxWidth).slice(0, 3);
  lines[2] = ellipsize(lines[2], 42, maxWidth);
  return { size: 42, lines };
}

export function ogSvg({ title, eyebrow = '炜轩的blog · 技术笔记', meta = '' }: OgOptions): string {
  const { size, lines } = fitTitle(title);
  const lineHeight = Math.round(size * 1.2);

  // 行数越少，标题整体越往下压，视觉上仍然居中在标题区
  const firstBaseline = 196 + (3 - lines.length) * 46;
  const titleText = lines
    .map(
      (line, i) =>
        `<text x="72" y="${firstBaseline + i * lineHeight}" font-family="${FONT}" font-size="${size}" font-weight="500" fill="#f5f3fb" letter-spacing="-1">${escapeXml(line)}</text>`,
    )
    .join('\n    ');

  const metaText = ellipsize(meta, 22, 660);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#07060e"/>
      <stop offset="0.55" stop-color="#050509"/>
      <stop offset="1" stop-color="#050509"/>
    </linearGradient>
    <linearGradient id="sparkMark" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7db4ff"/>
      <stop offset="0.52" stop-color="#a78bfa"/>
      <stop offset="1" stop-color="#f0a6ca"/>
    </linearGradient>
    <radialGradient id="glowA" cx="0.84" cy="0.1" r="0.64">
      <stop offset="0" stop-color="#8b5cf6" stop-opacity="0.3"/>
      <stop offset="0.55" stop-color="#8b5cf6" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="0.06" cy="0.94" r="0.6">
      <stop offset="0" stop-color="#4b8dff" stop-opacity="0.2"/>
      <stop offset="1" stop-color="#4b8dff" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glowA)"/>
  <rect width="${W}" height="${H}" fill="url(#glowB)"/>

  <g fill="none" stroke="#a78bfa">
    <circle cx="1092" cy="132" r="74" stroke-opacity="0.16" stroke-width="1.5"/>
    <circle cx="1092" cy="132" r="136" stroke-opacity="0.1" stroke-width="1.5"/>
    <circle cx="1092" cy="132" r="206" stroke-opacity="0.06" stroke-width="1.5"/>
    <circle cx="1092" cy="132" r="286" stroke-opacity="0.03" stroke-width="1.5"/>
  </g>

  <g transform="translate(72 42)">
    <path d="M14 4.6c.68 7.2 4.14 10.66 11.34 11.34.8.08.8 1.32 0 1.4C18.14 18.02 14.68 21.48 14 28.68c-.08.8-1.32.8-1.4 0-.68-7.2-4.14-10.66-11.34-11.34-.8-.08-.8-1.32 0-1.4C8.46 15.26 11.92 11.8 12.6 4.6c.08-.8 1.32-.8 1.4 0Z" fill="url(#sparkMark)"/>
    <path d="M25.4 1.8c.28 2.98 1.94 4.64 4.92 4.92.34.03.34.53 0 .56-2.98.28-4.64 1.94-4.92 4.92-.03.34-.53.34-.56 0-.28-2.98-1.94-4.64-4.92-4.92-.34-.03-.34-.53 0-.56 2.98-.28 4.64-1.94 4.92-4.92.03-.34.53-.34.56 0Z" fill="url(#sparkMark)" opacity="0.82"/>
  </g>

  <text x="72" y="110" font-family="${FONT}" font-size="21" letter-spacing="3" fill="#aaa4bc">${escapeXml(eyebrow)}</text>

  ${titleText}

  <line x1="72" y1="512" x2="1128" y2="512" stroke="#ffffff" stroke-opacity="0.08"/>

  <text x="72" y="556" font-family="${FONT}" font-size="22" fill="#aaa4bc">${escapeXml(metaText)}</text>
  <text x="1128" y="556" font-family="${MONO}" font-size="21" letter-spacing="0.5" text-anchor="end" fill="#b3a4ff">wx-blog.github.io</text>
</svg>`;
}
