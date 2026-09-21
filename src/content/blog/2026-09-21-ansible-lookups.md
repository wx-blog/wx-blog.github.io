---
title: Ansible Lookups 与模板函数：lookup、query、now 与 undef
description: Lookup 让 playbook 能从文件、数据库、API 等外部来源取数据，并且全在控制节点求值。这篇讲清 lookup 与 query 的区别、什么时候必须用 q()、now() 取当前时间，以及 undef() 这个能显式制造未定义变量的冷门函数。
pubDate: 2026-09-21
tags: [Ansible, Lookups, 自动化运维]
---

Playbook 里的数据不一定都写在变量文件里——密码可能在本地文件、配置可能来自外部系统。Lookup 插件就是干这个的：**从外部来源把数据取进模板系统**。

有一个前提必须先说清楚：**Lookup 在 Ansible 控制节点上执行**，不是在目标主机上。所以它能读控制节点的文件和环境，目标机看不到的东西照样能取到。

## lookup 的基本用法

`lookup()` 是个函数，用起来像一个"把外部数据拉进来"的表达式：

```yaml
vars:
  motd_value: "{{ lookup('file', '/etc/motd') }}"
tasks:
  - debug:
      msg: "motd value is {{ motd_value }}"
```

第一个参数是**插件名**，必填；后面跟插件自己的参数。

:::warn
如果 lookup 插件来自某个 collection，**必须写完整限定名**（如 `ns.col.lookup_items`）。原因是 `collections` 关键字对 lookup 插件不生效——你没法靠 playbook 顶部的 `collections:` 声明来省略前缀。这是很容易卡住的一点。
:::

`lookup` 还有一个可选的布尔参数 `wantlist`，默认 `False`。它是返回类型的分水岭：

- `wantlist=False`（默认）→ 拿到**字符串**（多个结果会被拼起来）
- `wantlist=True` → 保证拿到**列表**

## query / q：想要列表时的简写

`query()` 和它的简写 `q()` 完全等价于 `lookup(..., wantlist=True)`：

```yaml
block:
  - debug:
      msg: "{{ item }}"
    loop: "{{ lookup('ns.col.lookup_items', wantlist=True) }}"

  - debug:
      msg: "{{ item }}"
    loop: "{{ q('ns.col.lookup_items') }}"
```

两段完全等价，但**配合 `loop` 时 `q()` 明显更干净**。

这里有个实践上的判断依据：**只要结果要交给 `loop`，就该用 `q()`**。因为 `loop` 不接受字符串——它要求列表。用默认的 `lookup()` 拿到字符串再丢给 `loop`，是典型的报错来源。

## 查看有哪些插件可用

```bash
ansible-doc -l -t lookup
```

这会列出控制节点上所有已安装的 lookup 插件。`ansible-core` 自带一批，其余的来自各种 collection——**用之前先确认装没装**，别照着文档写完才发现插件不存在。

## now()：取当前时间

`now()` 返回当前时间，从 Ansible 2.8 开始提供。返回的可以是 Python `datetime` 对象，也可以是字符串表示：

```yaml
vars:
  current_time: "{{ now() }}"
```

它支持 `utc` 参数控制是否按 UTC 返回。用它的典型场景是**时间戳**：备份文件名、快照名、变更记录里插入当前时间。

:::note
`now()` 在**每次求值时都会重新计算**。所以同一个 `now()` 表达式在模板里出现两次，两次的结果可能差几毫秒。要做"同一次执行里时间戳一致"，先赋值给变量再引用。
:::

## undef()：显式制造一个未定义变量

这个函数比较冷门，但解决一个真实问题：**在某些作用域里临时"取消"一个低优先级变量的值**。

```jinja2
{{ undef() }}
```

它的效果就是让这个表达式求值为"未定义"。之所以有用，是因为 Ansible 的变量优先级里，`defaults` 里的低优先级值平时总是能生效；而 `undef()` 可以让你在局部把它**主动抹掉**。

它接受一个可选参数 `hint`，用来在报错时给出更清楚的说明：

```jinja2
{{ undef("vaulted_credentials is intentionally undefined here") }}
```

比如某个变量是"故意不给值"的（敏感凭据留空等），加上 hint 后，别人看到报错就知道这是有意为之，不会去乱改。

:::warn
`hint` 只有在 `DEFAULT_UNDEFINED_VAR_BEHAVIOR` 配置成"遇到未定义变量就报错"时才看得到。如果配置成静默忽略，提示信息不会显示，容易误以为 `undef()` 没生效。
:::

## 模板里的 Python 3 兼容坑

Ansible 的模板底层是 Jinja2，而 Jinja2 直接用 Python 的数据类型和标准函数。所以**Python 版本差异会直接渗进模板**。

最典型的是字典的三个方法：

| 方法 | Python 2 | Python 3 |
|---|---|---|
| `dict.keys()` | 返回**列表** | 返回 **view 对象** |
| `dict.values()` | 返回**列表** | 返回 **view 对象** |
| `dict.items()` | 返回**列表** | 返回 **view 对象** |

Python 2 下拿到列表，Ansible 能把它的字符串表示重新解析回列表；**Python 3 的 view 对象做不到这一点**——它的字符串表示不是一个能还原的列表。

结果就是把 `.keys()` 直接丢给 `loop` 在 Python 3 上会失败：

```yaml
vars:
  hosts:
    testhost1: 127.0.0.2
    testhost2: 127.0.0.3

tasks:
  - debug:
      msg: '{{ item }}'
    # 仅适用于 Python 2
    # loop: "{{ hosts.keys() }}"

    # 同时适用于 Python 2 和 Python 3
    loop: "{{ hosts.keys() | list }}"
```

**结论很简单：凡是用 `keys()` / `values()` / `items()` 并且期望列表，一律显式加 `| list`。**

另外，Python 2 的 `iterkeys()` / `itervalues()` / `iteritems()` 在 Python 3 里**已经不存在了**，一律换成对应的 `keys()` / `values()` / `items()` 再配 `| list`：

```jinja2
hosts.keys() | list
hosts.values() | list
hosts.items() | list
```

## 踩坑清单

| 现象 | 原因 | 处理 |
|---|---|---|
| `loop` 报"不是列表" | `lookup()` 默认返回字符串 | 改用 `q()`，或加 `wantlist=True` |
| lookup 插件找不到 | 来自 collection 但没写全限定名 | 写 `ns.col.plugin`，`collections` 关键字无效 |
| 模板在 Python 3 上遍历字典失败 | view 对象无法被解析成列表 | 统一加 `\| list` |
| `undef()` 的提示看不到 | 未定义行为被配置成静默 | 检查 `DEFAULT_UNDEFINED_VAR_BEHAVIOR` |
| 两处 `now()` 值不一致 | 每次求值都重新计算 | 先赋值给变量再引用 |

## 速查

```bash
ansible-doc -l -t lookup          # 列出可用插件
```

```yaml
"{{ lookup('file', '/etc/motd') }}"          # 取回字符串
"{{ q('ns.col.items') }}"                    # 取回列表（= wantlist=True）
"{{ now() }}"                                # 当前时间
"{{ now(utc=true) }}"                        # UTC 时间
"{{ undef('hint text') }}"                   # 显式未定义 + 提示
"{{ dict.items() | list }}"                  # Python3 安全写法
```

Lookup 的价值在于**打通 playbook 和外部世界**。真正要记住的就两条：**要列表就用 `q()`**，**遍历字典加 `| list`**。这两条能挡掉这个主题下绝大多数报错。
