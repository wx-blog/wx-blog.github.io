/**
 * 中文字体子集化。
 *
 * 为什么需要这一步：中文全字库 17MB，就算切成 unicode-range 片也还有 4MB，
 * 首屏拉下来会把加载时间拖到没法看。这里扫全站源码 + 文章，抽出真正出现的字符，
 * 只把这批字形编进 woff2——通常能压到几百 KB，而且是**准确的子集**，不会漏字。
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
const SRC_FONT = path.join(FONT_SRC_DIR, 'NotoSansSC-VF.ttf');
const OUT_DIR = path.join(projectRoot, 'public', 'fonts');
const SCAN_DIR = path.join(projectRoot, 'src');
const SCAN_EXT = new Set(['.astro', '.ts', '.js', '.mjs', '.md', '.mdx', '.css', '.json', '.html']);

/** 源字体：思源黑体的简体中文可变版本（SIL OFL 1.1，可商用） */
const FONT_URL =
  'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf';

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

async function ensureSourceFont() {
  try {
    await access(SRC_FONT);
    return;
  } catch {
    /* 还没有，下面下载 */
  }
  await mkdir(FONT_SRC_DIR, { recursive: true });
  process.stdout.write('· 下载中文字体源文件（约 17MB，只下一次，之后走本地缓存）\n');
  const res = await fetch(FONT_URL);
  if (!res.ok) throw new Error(`下载字体失败：${res.status} ${res.statusText}`);
  await writeFile(SRC_FONT, Buffer.from(await res.arrayBuffer()));
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

function humanSize(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)}MB`
    : `${(bytes / 1024).toFixed(1)}KB`;
}

async function main() {
  await ensureSourceFont();
  await mkdir(OUT_DIR, { recursive: true });

  const { chars, files } = await collectCharacters();
  const text = [...chars].join('');

  const source = await readFile(SRC_FONT);
  const subset = await subsetFont(source, text, {
    targetFormat: 'woff2',
    // 页面只用到 400/500/600，把可变轴收窄到 300–800，省掉两端用不上的字形
    variationAxes: { wght: { min: 300, max: 800, default: 400 } },
  });

  const magic = subset.subarray(0, 4).toString('latin1');
  if (subset.length < 8 * 1024 || magic !== 'wOF2') {
    throw new Error(`子集结果不合法（magic=${magic}，${subset.length} 字节），检查字体源文件`);
  }

  const outFont = path.join(OUT_DIR, 'noto-sans-sc.woff2');
  await writeFile(outFont, subset);

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

  const before = source.length;
  const after = subset.length;
  process.stdout.write(
    `· 字体子集完成：扫描 ${files} 个文件、${chars.size} 个字符\n` +
      `  中文字体 ${humanSize(before)} → ${humanSize(after)}` +
      `（${(100 - (after / before) * 100).toFixed(1)}% 压缩）\n`,
  );
}

main().catch((err) => {
  console.error('字体子集化失败：', err.message);
  process.exit(1);
});
