/**
 * remark 插件：把 `:::类型` 围栏转换成提示框（callout）。
 *
 * 用法（写在 Markdown 里）：
 *
 *   :::note
 *   这是一条普通提示。
 *   :::
 *
 *   :::warn 小心
 *   这一行会被当成标题。
 *   :::
 *
 * 支持的类型：note / tip / warn / danger
 *
 * 为什么自己写而不是装第三方：
 * 第三方 callout 插件大多会拉进一堆依赖，而且输出结构我们未必满意。
 * 这个需求本质就是把「一段围栏文本」换成「一个 div」，几十行就够，
 * 依赖越少、构建越稳，也不会因为上游改版而突然挂掉。
 *
 * ─────────────────────────────────────────────────────────────
 * 实现要点（踩过坑，别改回去）
 *
 * 1) **不做「提取纯文本 → 再重新解析」的往返。**
 *    remark 会把下面这段解析成【一个 paragraph】，子节点是
 *    text / inlineCode / strong 交替的混合序列：
 *
 *      :::note
 *      考试环境里 `/dev/sdb` 通常是给你操作的那块空盘。
 *      :::
 *
 *    子节点：text(":::note\n考试环境里 ") · inlineCode("/dev/sdb") · text(" 通常是…\n:::")
 *
 *    早先的实现用「把所有 text 拼起来、丢弃其它类型」拿到原始文本，
 *    结果 **行内代码被静默抠掉**（留下双空格），正文被悄悄改写。
 *    正确做法是：直接在这一串子节点上按「行」切分，遇到 non-text
 *    子节点就原样保留，只把命中围栏的文本行剥掉。
 *
 * 2) **绝不能产出块级元素嵌套在 <p> 里。**
 *    callout 是 <div>（块级）。如果它被塞进 <p>，浏览器会提前闭合
 *    外层 <p>，Astro 在流式渲染时对这段错位 HTML 的处理会中断，
 *    最终表现为 **整篇文章的正文静默消失，而构建退出码仍然是 0**。
 *    所以只要原本的 paragraph 里除了围栏还有其它内容，就必须拆成
 *    「前段 paragraph + callout + 后段 paragraph」三个平级节点，
 *    而不是把 callout 塞进原 paragraph。
 *
 * 3) 标题与正文一律用**纯文本**装，不再调 fromMarkdown 二次解析。
 *    callout 内部本来就是短句，行内代码用反引号原样保留即可，
 *    少一次解析就少一个出错面（也顺便避免了 allowDangerousHtml
 *    带来的 html 节点混入）。
 */

const TYPES = {
  note: { label: '说明', cls: 'callout--note' },
  tip: { label: '提示', cls: 'callout--tip' },
  warn: { label: '注意', cls: 'callout--warn' },
  danger: { label: '警告', cls: 'callout--danger' },
};

/** 匹配开头的 :::type[/ 可选标题] */
const OPEN_RE = /^:::\s*([a-zA-Z]+)\s*(.*)$/;
const CLOSE_RE = /^:::\s*$/;

export default function remarkCallout() {
  return (tree) => {
    const children = tree.children || [];
    const next = [];

    for (const node of children) {
      if (!isCalloutParagraph(node)) {
        next.push(node);
        continue;
      }
      next.push(...splitParagraph(node));
    }

    tree.children = next;
  };
}

/** 这个段落是不是一个 callout 围栏（开头行必须是 `:::type`） */
function isCalloutParagraph(node) {
  if (node.type !== 'paragraph') return false;
  const groups = toLineGroups(node);
  if (!groups.length) return false;
  const first = firstTextOf(groups[0]);
  const m = first.match(OPEN_RE);
  return !!(m && TYPES[m[1].toLowerCase()]);
}

/**
 * 把一个含围栏的段落拆成若干平级节点。
 *
 * 返回数组，元素只可能是：
 *   · 普通 paragraph（围栏之外的文字）
 *   · callout 节点（hName=div）
 *
 * 绝不把 callout 塞回 paragraph 内部 —— 见文件头第 2 点。
 */
function splitParagraph(node) {
  const groups = toLineGroups(node);
  const out = [];
  let buf = []; // 待成为普通段落的行组
  let i = 0;

  const flush = () => {
    if (!buf.length) return;
    out.push(makeParagraph(buf));
    buf = [];
  };

  while (i < groups.length) {
    const open = firstTextOf(groups[i]).match(OPEN_RE);
    const type = open && TYPES[open[1].toLowerCase()];

    if (!type) {
      buf.push(groups[i]);
      i += 1;
      continue;
    }

    // 找闭合围栏
    let end = -1;
    for (let j = i + 1; j < groups.length; j++) {
      if (CLOSE_RE.test(firstTextOf(groups[j]).trim())) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      // 没闭合：当作普通文字放过去，不吞内容
      buf.push(groups[i]);
      i += 1;
      continue;
    }

    flush();

    const inlineTitle = (open[2] || '').trim();
    const bodyGroups = groups.slice(i + 1, end);

    const callout = {
      type: 'callout',
      data: {
        hName: 'div',
        hProperties: { class: `callout ${type.cls}` },
      },
      children: [
        {
          type: 'paragraph',
          data: { hName: 'p', hProperties: { class: 'callout__title' } },
          children: [{ type: 'text', value: inlineTitle || type.label }],
        },
      ],
    };

    // 正文直接复用**原有的内联子节点**，行内代码 / 加粗 / 链接全部原样保留。
    // 这里刻意不再做「拼成字符串 → 重新解析」的往返：那样会重新引入
    // 行内代码被吞、以及解析结果与作者意图错位的风险。
    const bodyChildren = flattenGroups(bodyGroups);
    if (bodyChildren.length) {
      callout.children.push({
        type: 'paragraph',
        children: bodyChildren,
      });
    }

    out.push(callout);

    // 闭合围栏同一行若还有尾随文字，作为新段落继续解析
    const tail = tailTextOf(groups[end]).trim();
    if (tail) buf.push([{ type: 'text', value: tail }]);

    i = end + 1;
  }

  flush();
  return out;
}

/**
 * 把段落子节点按「行」分组。
 *
 * 返回 LineGroup[][]：外层是行，内层是该行上的若干子节点。
 * 纯文本子节点按 \n 拆开；inlineCode / strong / link 等
 * **原样保留**（不再被丢弃），只是它们的边界不参与切行。
 */
function toLineGroups(node) {
  const lines = [[]];
  for (const child of node.children || []) {
    if (child.type === 'text') {
      const parts = String(child.value).split('\n');
      for (let k = 0; k < parts.length; k++) {
        if (k > 0) lines.push([]);
        if (parts[k] !== '') lines[lines.length - 1].push({ type: 'text', value: parts[k] });
      }
    } else if (child.type === 'break') {
      lines.push([]);
    } else {
      // 行内代码、加粗、链接……原样塞进当前行
      lines[lines.length - 1].push(child);
    }
  }
  return lines;
}

/** 取一行开头那段纯文本（用于判定围栏）。行内代码不影响判定。 */
function firstTextOf(group) {
  for (const c of group) {
    if (c.type === 'text') return c.value;
    if (c.type === 'inlineCode') return '`' + c.value + '`';
  }
  return '';
}

/** 把一行还原成字符串（行内代码加回反引号） */
function lineToString(group) {
  return group
    .map((c) => {
      if (c.type === 'text') return c.value;
      if (c.type === 'inlineCode') return '`' + c.value + '`';
      if (c.type === 'strong' || c.type === 'emphasis') return firstTextOf(c.children || []);
      return '';
    })
    .join('');
}

/** 闭合围栏行上，`:::` 之后的剩余文字 */
function tailTextOf(group) {
  const s = lineToString(group);
  return s.replace(/^:::\s*/, '');
}

/** 把若干行合成纯文本（保留段落内换行，与源文一致） */
function joinLines(groups) {
  return groups.map(lineToString).join('\n');
}

/**
 * 把行组拍平成一串内联子节点，供 callout 正文直接使用。
 *
 * 行与行之间补一个换行文本节点：与普通段落里 remark 的表示一致，
 * 行内代码、加粗等节点被原样带过，不再被丢弃或降级成字面反引号。
 */
function flattenGroups(groups) {
  const children = [];
  let wrote = false;
  for (const group of groups) {
    if (wrote) children.push({ type: 'text', value: '\n' });
    children.push(...group);
    wrote = true;
  }
  // 去掉首尾的纯空白，避免 callout 里多出空行
  while (children.length && children[0].type === 'text' && !children[0].value.trim()) children.shift();
  while (children.length && children[children.length - 1].type === 'text' && !children[children.length - 1].value.trim()) {
    children.pop();
  }
  if (children.length && children[children.length - 1].type === 'text') {
    children[children.length - 1] = {
      type: 'text',
      value: children[children.length - 1].value.replace(/\s+$/, ''),
    };
  }
  if (children.length && children[0].type === 'text') {
    children[0] = { type: 'text', value: children[0].value.replace(/^\s+/, '') };
  }
  return children.filter((c) => !(c.type === 'text' && c.value === ''));
}

/** 把行组包成一个普通 paragraph */
function makeParagraph(groups) {
  const children = [];
  groups.forEach((group, idx) => {
    if (idx > 0) children.push({ type: 'text', value: '\n' });
    children.push(...group);
  });
  return { type: 'paragraph', children };
}
