/**
 * 中文折行处理（remark 插件）。
 *
 * Markdown 里段落内的换行会被当成空格。中文段落一旦按行折行，
 * 渲染出来就会变成「中 文 会 出 现 空 格」——这是中文写作者最常踩的排版坑。
 *
 * 这里只在纯文本节点里清掉「中日韩字符 + 空白 + 中日韩字符」中的空白：
 *   · 行内代码与代码块是独立节点类型，不会被碰到
 *   · 中文与英文/数字之间的空格**保留**（那是有意加的，比如「订阅 RSS」）
 *   · 中文与标点、中文与全角标点之间的换行也一并清掉
 */
const CJK =
  '\\u2E80-\\u303F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF';

const SPACE_BETWEEN_CJK = new RegExp(`([${CJK}])[ \\t\\n\\r]+(?=[${CJK}])`, 'g');

function walk(node) {
  if (!node || typeof node !== 'object') return;

  if (node.type === 'text' && typeof node.value === 'string') {
    node.value = node.value.replace(SPACE_BETWEEN_CJK, '$1');
    return;
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child);
  }
}

export default function remarkCjkSpacing() {
  return (tree) => {
    walk(tree);
  };
}
