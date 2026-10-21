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

function wrap(text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  let width = 0;

  for (const token of tokenize(text)) {
    if (token === ' ') {
      if (line && width + size * 0.3 <= maxWidth) {
        line += ' ';
        width += size * 0.3;
      }
      continue;
    }

    const tokenWidth = measure(token, size);
    if (width + tokenWidth > maxWidth && line) {
      // 行首不能是收尾标点：宁可让这一行略微超宽，也不让它孤零零落到下一行
      if (CLOSING.test(token)) {
        line += token;
        width += tokenWidth;
        continue;
      }
      lines.push(line.trimEnd());
      line = token;
      width = tokenWidth;
    } else {
      line += token;
      width += tokenWidth;
    }
  }

  if (line.trim()) lines.push(line.trimEnd());
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

  for (let size = initial; size >= 42; size -= 4) {
    const lines = wrap(title, size, maxWidth);
    if (lines.length <= 3) return { size, lines };
  }

  const lines = wrap(title, 42, maxWidth).slice(0, 3);
  if (lines.length === 3) {
    lines[2] = ellipsize(lines[2], 42, maxWidth);
  }
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
        `<text x="72" y="${firstBaseline + i * lineHeight}" font-family="${FONT}" font-size="${size}" font-weight="600" fill="#e8ecf4" letter-spacing="-1">${escapeXml(line)}</text>`,
    )
    .join('\n    ');

  const metaText = ellipsize(meta, 22, 660);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d1524"/>
      <stop offset="0.55" stop-color="#080c15"/>
      <stop offset="1" stop-color="#06080e"/>
    </linearGradient>
    <radialGradient id="glowA" cx="0.84" cy="0.12" r="0.62">
      <stop offset="0" stop-color="#6cb4e0" stop-opacity="0.22"/>
      <stop offset="0.55" stop-color="#6cb4e0" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#6cb4e0" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="0.08" cy="0.92" r="0.55">
      <stop offset="0" stop-color="#8b7cf6" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#8b7cf6" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glowA)"/>
  <rect width="${W}" height="${H}" fill="url(#glowB)"/>

  <g fill="none" stroke="#6cb4e0">
    <circle cx="1092" cy="132" r="74" stroke-opacity="0.12" stroke-width="1.5"/>
    <circle cx="1092" cy="132" r="136" stroke-opacity="0.08" stroke-width="1.5"/>
    <circle cx="1092" cy="132" r="206" stroke-opacity="0.05" stroke-width="1.5"/>
    <circle cx="1092" cy="132" r="286" stroke-opacity="0.03" stroke-width="1.5"/>
  </g>

  <rect x="72" y="58" width="40" height="3" rx="1.5" fill="#6cb4e0"/>

  <text x="72" y="96" font-family="${FONT}" font-size="21" letter-spacing="3" fill="#8b94a7">${escapeXml(eyebrow)}</text>

  ${titleText}

  <line x1="72" y1="512" x2="1128" y2="512" stroke="#ffffff" stroke-opacity="0.09"/>

  <text x="72" y="556" font-family="${FONT}" font-size="22" fill="#8b94a7">${escapeXml(metaText)}</text>
  <text x="1128" y="556" font-family="${MONO}" font-size="21" letter-spacing="0.5" text-anchor="end" fill="#6cb4e0">wx-blog.github.io</text>
</svg>`;
}
