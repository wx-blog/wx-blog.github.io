---
title: Jinja2 模板语法精讲：变量、过滤器、控制流与模板继承
description: Ansible 的模板能力完全来自 Jinja2。这篇把模板的三种分隔符、变量访问的两种写法、过滤器与测试的用法、空白控制、转义技巧讲清楚，最后讲透模板继承里的 block 与 super——这几条撑起了日常写模板的九成场景。
pubDate: 2026-09-21
tags: [Ansible, Jinja2, 模板]
---

只要开始写 Ansible 的 `template` 模块，就绕不开 Jinja2。它决定了模板里能写什么、怎么写、以及渲染出来长什么样。

先建立一个前提认识：**所有模板渲染都发生在控制节点**，渲染完的成品才被送到目标主机。所以目标机不需要装 Jinja2，传输的数据量也更小。另一个直接后果是——**模板文件必须是 UTF-8 编码**，否则中文会乱。

## 三种分隔符

模板里只有三种语法结构，记住它们就抓住了骨架：

```jinja2
{% ... %}   {# 语句：for、if、block 这类控制逻辑 #}
{{ ... }}   {# 表达式：输出变量的值 #}
{# ... #}   {# 注释：不会出现在渲染结果里 #}
```

一个最小的模板长这样：

```jinja2
<ul id="navigation">
{% for item in navigation %}
    <li><a href="{{ item.href }}">{{ item.caption }}</a></li>
{% endfor %}
</ul>

{# a comment #}
```

`{% for %}` 是逻辑，`{{ }}` 是输出，`{# #}` 是注释。三者的分工非常清楚。

## 变量访问：点号和方括号的区别

这两种写法看起来一样，实际查找顺序不同：

```jinja2
{{ foo.bar }}     {# 先试属性访问，再试下标访问 #}
{{ foo['bar'] }}  {# 先试下标访问，再试属性访问 #}
```

多数情况下结果相同。但当一个字典的 key 恰好和字典自身的方法名重名时（比如 key 叫 `items` 或 `keys`），两者就会出现差异——**点号会先拿到方法本身**，方括号才能拿到你要的值。

所以遇到"值取出来是个函数对象"这种怪现象，先把它换成方括号试试。

如果变量或属性不存在，会得到 `undefined` 值，具体报错还是静默取决于配置。

## 过滤器：用管道串联

过滤器用 `|` 调用，可以串联，前一个的输出喂给下一个：

```jinja2
{{ name|striptags|title }}
```

意思是：先剥掉 `name` 里的 HTML 标签，再转成标题格式。

带参数的过滤器用括号：

```jinja2
{{ listx|join(', ') }}
```

几个最常用的：

```jinja2
{{ my_variable|default('not set') }}          {# 未定义时给默认值 #}
{{ "Hello World"|replace("Hello", "Goodbye") }}  {# 字符串替换 #}
{{ 42.55|round }}                              {# 四舍五入 #}
{{ users|selectattr("is_active") }}            {# 按属性筛选对象列表 #}
{{ cities|sort }}                              {# 排序 #}
```

:::note
`default` 是写模板时用得最多的一个。任何"这个变量可能没传"的地方都该套一层 `| default(...)`——**让模板宽容，比让 playbook 在渲染阶段炸掉要好得多**。
:::

## 测试：is 判断条件

测试（Tests）用来判断变量是否满足某种条件，语法是 `is`：

```jinja2
{% if name is defined %}
    Name exists.
{% endif %}
```

带参数的测试也支持两种写法，等价：

```jinja2
{% if loop.index is divisibleby 3 %}
{% if loop.index is divisibleby(3) %}
```

## 注释与空白控制

注释可以整块注释掉模板代码：

```jinja2
{#
{% for user in users %}
    ...
{% endfor %}
#}
```

**空白控制**是 Jinja2 里最容易被忽视、又最容易把输出搞乱的部分。默认会移除一个尾随换行，其余空白保留。手动控制靠 `-`：

```jinja2
{% for item in seq -%}
    {{ item }}
{%- endfor %}
```

如果 `seq` 是 1 到 9，这段会紧凑输出成 `123456789`——换行和缩进都被吃掉了。

:::warn
`-` 和标签内容之间**不能有空格**。`{%- if foo -%}` 合法，`{% - if foo - %}` 不合法。这类错误不报语法问题，只是空白没被吃掉，输出里多出一堆空行——很容易被当成"数据错了"去查半天。
:::

## 想输出 `{{` 本身：转义

模板里要写 Jinja 语法本身（比如写文档、写教程）时，得告诉 Jinja"别解析它"：

```jinja2
{{ '{{' }}
```

要整段不解析，用 `raw`：

```jinja2
{% raw %}
    <ul>
    {% for item in seq %}
        <li>{{ item }}</li>
    {% endfor %}
    </ul>
{% endraw %}
```

## 模板继承：block 与 super

这是 Jinja2 最有价值的功能。把页面通用结构写在父模板，子模板只覆盖需要改的部分。

父模板定义"可覆盖区域"：

```jinja2
<!DOCTYPE html>
<html lang="en">
<head>
    {% block head %}
    <link rel="stylesheet" href="style.css" />
    <title>{% block title %}{% endblock %} - My Webpage</title>
    {% endblock %}
</head>
<body>
    <div id="content">{% block content %}{% endblock %}</div>
</body>
</html>
```

子模板继承并覆盖：

```jinja2
{% extends "base.html" %}

{% block title %}Index{% endblock %}

{% block head %}
    {{ super() }}
    <style type="text/css">
        .important { color: #336699; }
    </style>
{% endblock %}

{% block content %}
    <h1>Index</h1>
{% endblock %}
```

四条规则要记牢：

1. `{% extends "base.html" %}` 声明继承关系
2. 子模板用同名 `block` 覆盖父模板的对应区域
3. **`{{ super() }}` 是保留父模板内容再追加**——上面例子里 `head` 块既有父级的样式表，又有子级新增的 `<style>`，靠的就是它
4. 没被覆盖的块，用父模板的默认内容

多层继承还能链式跳过中间层：

```jinja2
{{ super.super() }}
```

### endblock 后面的名字

`endblock` 后面可以写上块名提高可读性，但**必须和对应的 block 名字一致**，写错就是语法错误：

```jinja2
{% block sidebar %}
    {% block inner_sidebar %}
        ...
    {% endblock inner_sidebar %}
{% endblock sidebar %}
```

### scoped 与 required

默认情况下 block **访问不到外层作用域的变量**。在循环里定义 block 时会踩到这一点：

```jinja2
{% for item in seq %}
    <li>{% block loop_item %}{{ item }}{% endblock %}</li>
{% endfor %}
```

加 `scoped` 才能拿到循环变量：

```jinja2
{% for item in seq %}
    <li>{% block loop_item scoped %}{{ item }}{% endblock %}</li>
{% endfor %}
```

`required` 表示这个块**必须被子模板覆盖**，否则渲染直接报错——适合用来强制某个区域不能被遗漏：

```jinja2
{% block body required %}{% endblock %}
```

两者同时用时，`required` 放后面：

```jinja2
{% block body scoped required %}{% endblock %}
```

## 转义与安全

生成 HTML 时，变量里如果含 `<`、`>`、`&`、`"`，可能破坏结构。手动转义：

```jinja2
{{ user.username|e }}
```

自动转义是否开启取决于应用配置。如果某段内容确认可信、不想被转义，用 `safe` 标记：

```jinja2
{{ trusted_html|safe }}
```

:::warn
`safe` 是在关掉一道防护。只有内容完全由你控制时才用——变量来自用户输入或外部接口时，加 `safe` 等于自己打开注入口子。
:::

## 踩坑清单

| 现象 | 原因 | 处理 |
|---|---|---|
| 输出里多出一堆空行 | `-` 空白控制没写或写错位置 | 用 `{%- ... -%}`，注意 `-` 紧贴标签无空格 |
| 变量取到的是方法而不是值 | key 与字典方法重名，用了点号 | 改用方括号 `foo['bar']` |
| block 里拿不到循环变量 | block 默认不继承外层作用域 | 加 `scoped` |
| 中文乱码 | 模板文件不是 UTF-8 | 存为 UTF-8 |
| `endblock` 报语法错 | 后面的名字与 block 名不一致 | 要么不写名字，要么写对 |
| 模板里想展示 `{{ }}` 却被打值 | 被 Jinja 解析了 | 用 `{{ '{{' }}` 或 `{% raw %}` |

## 速查

```jinja2
{% ... %}              {# 语句 #}
{{ ... }}              {# 输出 #}
{# ... #}              {# 注释 #}
{{ var|default('x') }} {# 默认值 #}
{{ list|join(', ') }}  {# 连接 #}
{% if x is defined %}  {# 测试 #}
{%- ... -%}            {# 去空白 #}
{% raw %} ... {% endraw %}   {# 不解析 #}
{% extends "base" %}   {# 继承 #}
{{ super() }}          {# 保留父级内容 #}
```

Jinja2 的语法量不大，真正要养成的习惯只有两个：**变量都套 `default`**，以及**空白控制该加就加**。这两条能省掉后面八成的排查时间。
