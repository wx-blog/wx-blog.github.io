/**
 * 中文字体子集化。
 *
 * 为什么需要这一步：中文全字库 17~24MB，就算切成 unicode-range 片也还有 4MB，
 * 首屏拉下来会把加载时间拖到没法看。这里扫全站源码 + 文章，抽出真正出现的字符，
 * 只把这批字形编进 woff2——通常能压到几百 KB，而且是**准确的子集**，不会漏字。
 *
 * 现在有两套中文字：思源黑体（正文，扫全站）与思源宋体（只抽首屏标题
 * 与欢迎语，约一百字），各自压成独立的 woff2；宋体只在首页被 @font-face
 * 实际使用，其他页面不会下载它。
 *
 * 因为接在 build 前面跑，子集永远和内容同步，不会出现「新文章有字缺字形」。
 *
 *   npm run fonts   # 手动重跑
 *   npm run build   # 自动先跑这个再构建
 */
import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import subsetFont from 'subset-font';

const projectRoot = path.resolve(import.meta.dirname, '..');
const FONT_SRC_DIR = path.join(projectRoot, '.font-src');
const OUT_DIR = path.join(projectRoot, 'public', 'fonts');
const SCAN_DIR = path.join(projectRoot, 'src');
const SCAN_EXT = new Set(['.astro', '.ts', '.js', '.mjs', '.md', '.mdx', '.css', '.json', '.html']);

/** 源字体：思源黑体 / 思源宋体的简体中文可变版本（SIL OFL 1.1，可商用） */
const SANS = {
  label: '思源黑体',
  src: path.join(FONT_SRC_DIR, 'NotoSansSC-VF.ttf'),
  out: 'noto-sans-sc.woff2',
  url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf',
};

const SERIF = {
  label: '思源宋体',
  src: path.join(FONT_SRC_DIR, 'NotoSerifSC-VF.ttf'),
  out: 'noto-serif-sc.woff2',
  url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Serif/Variable/TTF/Subset/NotoSerifSC-VF.ttf',
};

/**
 * 源码里不一定出现、但页面上随时可能用到的符号。
 * 少了这批，浏览器会拿回退字体渲染，字形会跟正文对不上。
 */
const EXTRA =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' +
  ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~' +
  '·—–…‘’“”《》〈〉「」『』【】〔〕（）［］｛｝：；，。、！？' +
  '％＃＆＊＋－／＝＠｜～￥€£°±×÷≈≠≤≥∞√∅∑∫' +
  '①②③④⑤⑥⑦⑧⑨⑩⑴⑵⑶⑷⑸' +
  '←↑→↓↔⇒▲▼◀▶✓✗★☆●○◆◇■□▪▫' +
  '§¶†‡№℃℉‰‱';

async function ensureSourceFont({ label, src, url }) {
  try {
    await access(src);
    return;
  } catch {
    /* 还没有，下面下载 */
  }
  await mkdir(FONT_SRC_DIR, { recursive: true });
  process.stdout.write(`· 下载${label}源文件（只下一次，之后走本地缓存）\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载${label}失败：${res.status} ${res.statusText}`);
  await writeFile(src, Buffer.from(await res.arrayBuffer()));
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function collectCharacters() {
  const chars = new Set();
  let files = 0;

  for await (const file of walk(SCAN_DIR)) {
    if (!SCAN_EXT.has(path.extname(file))) continue;
    files += 1;
    const text = await readFile(file, 'utf8');
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      // 跳掉控制字符，其余照收
      if (cp < 0x20 || cp === 0x7f) continue;
      chars.add(ch);
    }
  }

  for (const ch of EXTRA) chars.add(ch);
  return { chars, files };
}

/**
 * 宋体只服务首屏标题与欢迎语，没必要背整站的字库。
 * 直接从 index.astro 里抽出这两个元素的文案，换文案时子集会自动跟上；
 * 再补一套基础拉丁与标点，避免数字或分隔符回退到系统宋体。
 */
async function collectSerifCharacters() {
  const source = await readFile(path.join(SCAN_DIR, 'pages', 'index.astro'), 'utf8');
  const blocks = source.matchAll(
    /<(h1|p)\b[^>]*class="[^"]*\bhero__(?:title|welcome)\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g,
  );
  const chars = new Set(
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ' +
      '·—–…，。、！？：；「」『』（）《》〈〉【】',
  );
  for (const [, , inner] of blocks) {
    const text = inner.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ');
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x20 && cp !== 0x7f) chars.add(ch);
    }
  }
  return chars;
}

function humanSize(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)}MB`
    : `${(bytes / 1024).toFixed(1)}KB`;
}

async function subsetCjk({ label, src, out }, text) {
  const source = await readFile(src);
  const subset = await subsetFont(source, text, {
    targetFormat: 'woff2',
    // 页面只用到 400/500/600，把可变轴收窄到 300–800，省掉两端用不上的字形
    variationAxes: { wght: { min: 300, max: 800, default: 400 } },
  });

  const magic = subset.subarray(0, 4).toString('latin1');
  if (subset.length < 8 * 1024 || magic !== 'wOF2') {
    throw new Error(
      `${label}子集结果不合法（magic=${magic}，${subset.length} 字节），检查字体源文件`,
    );
  }

  await writeFile(path.join(OUT_DIR, out), subset);
  return { before: source.length, after: subset.length };
}

async function main() {
  await Promise.all([ensureSourceFont(SANS), ensureSourceFont(SERIF)]);
  await mkdir(OUT_DIR, { recursive: true });

  const { chars, files } = await collectCharacters();
  const serifChars = await collectSerifCharacters();
  const text = [...chars].join('');
  const serifText = [...serifChars].join('');

  const [sans, serif] = await Promise.all([
    subsetCjk(SANS, text),
    subsetCjk(SERIF, serifText),
  ]);

  // 拉丁字形单独用 Inter：它的 latin 切片本来就只有 40KB 左右，不需要再切
  const interSrc = path.join(
    projectRoot,
    'node_modules',
    '@fontsource-variable',
    'inter',
    'files',
    'inter-latin-wght-normal.woff2',
  );
  await copyFile(interSrc, path.join(OUT_DIR, 'inter-latin.woff2'));

  const report = (label, { before, after }) =>
    `  ${label} ${humanSize(before)} → ${humanSize(after)}` +
    `（${(100 - (after / before) * 100).toFixed(1)}% 压缩）\n`;

  process.stdout.write(
    `· 字体子集完成：扫描 ${files} 个文件、${chars.size} 个字符\n` +
      report('思源黑体', sans) +
      report(`思源宋体（首屏 ${serifChars.size} 字）`, serif),
  );
}

main().catch((err) => {
  console.error('字体子集化失败：', err.message);
  process.exit(1);
});
