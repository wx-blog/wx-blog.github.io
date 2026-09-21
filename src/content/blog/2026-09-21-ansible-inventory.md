---
title: Ansible 主机清单深入：从 INI 到 podman 动态清单
description: 清单是 Ansible 的地基，写法不复杂但坑很集中。这篇把清单的优先级、INI 与 YAML 的取舍、默认组与父子组、同名主机的重复执行问题讲清楚，并跑通一个基于 podman 插件的动态清单。
pubDate: 2026-09-21
tags: [Ansible, 自动化运维, 主机清单]
---

Ansible 里几乎所有"莫名其妙"的问题，最后都会回到清单上：为什么 pattern 匹配不到主机、为什么同一个节点被执行了三次、为什么组名会报警告。这篇把清单从最基础讲到动态生成。

先记住一句话：**清单是"受管节点"的名单**，它只回答一个问题——有哪些主机、它们怎么分组。

## 清单放在哪，谁说了算

默认位置是 `/etc/ansible/hosts`。但用 pip 装的 Ansible **默认没有这个文件**，需要自己建。所以实践中几乎都在项目目录里自己维护一份，然后在 `ansible.cfg` 里指过去：

```ini
[defaults]
inventory = ./inventory
```

命令行用 `-i` 指定的清单，**优先级高于 `ansible.cfg`**：

```bash
# ansible.cfg 里配的是 ./inventory，这里临时换一个
ansible webservers -i inventory2 -m ping
```

`-i` 还可以给多次，把多个来源合并成一个清单：

```bash
ansible webservers,dbservers -i inventory2 -i inventory3.ini -m ping
```

这个用法在"公共清单 + 本次临时加几台机器"的场景里很好使。

## INI 还是 YAML

两种都支持，但**建议用 INI**——同样的内容它更短更直观：

```ini
# inventory4.ini
node1

[group1]
node2

[group2]
node3
```

YAML 版本要写四倍的行数，换来的是结构化：

```yaml
# inventory4.yaml
ungrouped:
  hosts:
    node1:
group1:
  hosts:
    node2:
group2:
  hosts:
    node3:
```

只有一种情况推荐 YAML：主机变量很多、需要用嵌套结构表达的时候。日常用 INI。

:::note
文件名后缀不影响功能，但写成 `.ini` 编辑器会给语法高亮，写错一眼能看出来。
:::

## 两个默认组

Ansible 自动维护两个组，不用你定义：

- **`all`** —— 所有主机
- **`ungrouped`** —— 没有归入任何自定义组的主机

用 `ansible-inventory` 可以把清单展开成 JSON 看结构，这比盯着原始文件猜要可靠得多：

```bash
ansible-inventory --list -i inventory3.ini
```

输出里会明确告诉你每个组有哪些主机、哪些是子组：

```json
{
  "_meta": { "hostvars": {}, "profile": "inventory_legacy" },
  "all": { "children": ["ungrouped", "dbservers"] },
  "dbservers": { "hosts": ["node2"] }
}
```

**排查 pattern 写错时，第一步就是跑这条命令**——十有八九是组名拼错或者层级理解错了。

## 一行主机可以同时属于多个组

```ini
node1
[web]
node1
[db]
node1
```

`node1` 既在 `web` 也在 `db`，同时因为出现了裸行而属于 `ungrouped`。用 `ansible web` 和 `ansible db` 都能选中它。

## 组的分组：父子关系

组可以嵌套。写法是 `[父组:children]`：

```ini
[group1:children]
group2

[group2:children]
group3

[group3]
node3
```

结果就是 `group1` 包含了 `group2`、`group3` 里的所有主机——**父组会自动继承子组的全部成员**，不需要重复列：

```bash
# group1 打过去，group2 / group3 的主机也会被覆盖
ansible group1 -i inventory6 -a id
```

:::warn
父子组**不要互相嵌套**（A 是 B 的子组、B 又是 A 的子组）。这不报错，但行为难以预料，排查起来很痛苦。关系必须是单向的树。
:::

## 同一个主机有多种写法，会执行多次

这一条最容易踩：清单里同一个物理机如果写了多个名字，Ansible 会把它们**当成不同主机**，于是一条任务被执行多次。

```ini
node1.example.com
192.168.1.101

[webservers]
node1
```

这三个条目都指向同一台机器，`ansible all` 会跑三遍：

```bash
ansible all -i inventory2 -m ping
# node1 | SUCCESS => ...
# 192.168.1.101 | SUCCESS => ...
# node1.example.com | SUCCESS => ...
```

要避免就选一种表示法贯穿到底。用 FQDN 的话建议顺手把 `known_hosts` 铺好，省得第一次连接卡在 yes/no 上。

## 动态清单：把 podman 容器当主机管

静态清单适合固定环境。容器这种随时起停的东西，手动维护清单不现实——Ansible 提供了**清单插件**，让清单在运行时动态生成。

以 podman 为例。先起两个带标签的容器：

```bash
podman run -d --name node-web --label group=web nginx:latest
podman run -d --name node-python --label group=test python:3-alpine sleep infinity
```

然后写一个插件配置文件，它本身就是清单：

```yaml
# podman_inventory.yml
plugin: containers.podman.podman_containers
connection_plugin: containers.podman.podman
include_stopped: false
group_by_image: true
```

`ansible-inventory -i podman_inventory.yml --list` 就能看到容器被自动识别成了主机，并按镜像名分组。

但有两点要注意：

**第一，镜像名里带 `.` 会触发警告。** 镜像名 `docker.m.daocloud.io/nginx` 会被转成组名 `image_docker.m.daocloud.io_nginx_latest`，而 `.` 对 Ansible 来说是组名的无效字符：

```
[WARNING]: Invalid characters were found in group names but not replaced
```

**第二，关掉自动分组、改用显式规则更可控。** 把 `group_by_image` 设为 `false`，改用 `groups` 里写条件表达式，既没有警告，分组逻辑也更清楚：

```yaml
plugin: containers.podman.podman_containers
connection_plugin: containers.podman.podman
include_stopped: false
# 禁用按镜像名自动分组，避免特殊字符警告
group_by_image: false
groups:
  podman_hosts: true
  # 带 group=web 标签的容器进 web_servers 组
  web_servers: "podman_labels.group == 'web'"
```

`groups` 的语法是 `组名: 条件表达式`。写 `true` 表示"所有容器都进这个组"，写表达式则按容器属性（标签、镜像名、运行状态）筛选。

最后验证连接方式确实切到了 podman：

```bash
ansible all -i podman_inventory.yml -m debug -a "var=ansible_connection"
# "ansible_connection": "containers.podman.podman"
```

连过去即可，不需要在这些容器里开 SSH。

:::note
动态清单的核心价值不是"少写几行配置"，而是**清单跟着环境自动变化**。容器销毁了，清单里就自动没有它了——静态清单做不到这一点。
:::

## 踩坑清单

| 现象 | 原因 | 处理 |
|---|---|---|
| 第一次连接卡住等 yes/no | 主机密钥未确认 | 手动 `ssh` 一次，或把 `StrictHostKeyChecking` 设为 `no` |
| `all` 里一台机器执行多次 | 同一主机用了多种名字 | 统一用 FQDN 或统一用 IP |
| 组名报警告 | 组名里有 `.` `-` 等字符 | 关掉自动分组，手写 `groups` 规则 |
| pattern 匹配不到主机 | 组名拼错或层级理解错 | `ansible-inventory --list` 展开看结构 |
| 父子组行为异常 | 组之间互相嵌套 | 改成单向的树形关系 |

## 速查

```bash
ansible-inventory --list -i <清单>        # 展开清单结构，排查首选
ansible <pattern> -i <清单> -m ping       # 连通性测试
ansible <pattern> -i <清单> -a id         # 执行临时命令
ansible <pattern> -i <清单> -m debug -a "var=<变量名>"  # 查变量
```

清单这一层没什么"高级技巧"，把上面的边界情况都摸过一遍，后面写 playbook 会顺很多。
