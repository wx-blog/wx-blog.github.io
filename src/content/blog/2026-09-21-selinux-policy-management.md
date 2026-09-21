---
title: SELinux 策略管理：从运行模式到端口标签与审计
description: 讲清 SELinux 三种运行模式、安全上下文、文件与端口标签、布尔值的实战配置，并用 audit2allow 把拒绝日志闭环成策略模块，覆盖怎么改加为什么加出错怎么办三层，适合强制模式下既保安全又不误伤业务。
tags: [Linux, SELinux, 安全]
pubDate: 2026-09-21
---

SELinux 是很多运维的「玄学」——服务起不来，一 `setenforce 0` 就好了，但 production 不能长期关。真正的解法不是关掉它，而是给它正确的标签、布尔值和端口标签。理解 SELinux 是「强制访问控制（MAC）」而非传统的「自主访问控制（DAC，即文件 rwx + 用户」），就明白为什么光改文件权限还不够。

## 三种运行模式

**怎么做**：查看当前模式用 `getenforce`，临时切换 `setenforce 0`（permissive，只记不拦）或 `1`（enforcing，真拦），永久改 `/etc/selinux/config` 的 `SELINUX=` 字段（`enforcing`/`permissive`/`disabled`）。

```bash
getenforce
setenforce 0
sestatus
```

**为什么**：`enforcing` 真拦、`permissive` 只记日志不拦、`disabled` 完全关闭且需重启。排错黄金流程：先切 `permissive` 验证「是不是 SELinux 的问题」——如果切了就通，基本锁定是标签/布尔值缺配，再针对性补，而不是永久关掉。

**出错怎么办**：`disabled` 改回 `enforcing` 必须重启，且文件系统标签可能需 `autorelabel`（启动时加 `autorelabel=1` 内核参数，或建 `/.autorelabel` 文件后重启）。不要长期 `disabled`，那等于卸掉一层防护，且重新启用时大量文件标签可能不正确。

## 安全上下文与文件标签

**怎么做**：每个文件/进程都有 `用户:角色:类型:级别` 四段上下文，真正起作用的是「类型」（type）。查看：

```bash
ls -Z /var/www/html
ps -Z -C httpd
```

把自定义 Web 目录打上 `httpd_sys_content_t`，让 httpd 能读：

```bash
semanage fcontext -a -t httpd_sys_content_t "/var/server/html(/.*)?"
restorecon -Rvv /var/server/html
```

**为什么**：SELinux 的 DAC 之上还有一层「类型强制（TE）」——即便文件 `644` 任何人可读，若类型不是 `httpd_sys_content_t`，httpd 进程（类型 `httpd_t`）仍被策略拒绝读。`chcon` 只是临时改标签，文件被重新创建或 `restorecon`/`relabel` 后又会变回默认。`semanage fcontext` 是把「路径→类型」写进策略数据库，再用 `restorecon` 应用，这才是**永久**做法。

**出错怎么办**：`chcon` 改完重启服务仍被拒，多半是后来 `restorecon` 把它还原了。正确链路永远是 `semanage fcontext` → `restorecon`，而非裸 `chcon`。新建子目录后要重新 `restorecon -R`。

## 布尔值：开着的服务开关

**怎么做**：SELinux 用布尔值控制「某个服务能否做某件事」，列出与 httpd 相关的：

```bash
getsebool -a | grep httpd
setsebool -P httpd_read_user_content on
```

**为什么**：`httpd_read_user_content` 控制 httpd 能否读用户家目录下的内容；`httpd_can_network_connect` 控制 httpd 能否对外发起网络连接（如连数据库/代理）；`-P` 表示写入持久化，否则重启丢。布尔值比改标签更轻量，是「行为级别」的授权，适合临时放开某种能力。

**出错怎么办**：httpd 读用户目录报权限拒绝，先 `getsebool httpd_read_user_content` 看是不是 `off`，开掉即可，不必动标签。httpd 连不上远端数据库时，除了查网络，也要查 `httpd_can_network_connect`。

## 端口标签

**怎么做**：服务监听非标准端口时，SELinux 默认不允许。把 90、888 加进 `http_port_t`，把 2222 加进 `ssh_port_t`：

```bash
semanage port -a -t http_port_t -p tcp 90
semanage port -a -t http_port_t -p tcp 888
semanage port -a -t ssh_port_t -p tcp 2222
```

查看当前端口类型范围：

```bash
semanage port -l | grep http_port_t
```

**为什么**：SELinux 维护「端口类型」表，httpd 只能绑 `http_port_t` 类端口。`-a` 新增；若端口已被别的类型占用（如 888 已在别的类型），要用 `-m` 修改而非 `-a`。

**出错怎么办**：`systemctl restart httpd` 报「无法绑定地址」但 `ss -lntp` 显示端口空闲，几乎肯定是端口没打标签。补 `semanage port` 后无需重启服务即可生效。改 SSH 端口到 2222 后，忘了 `ssh_port_t` 标签会导致 sshd 起不来。

## 用 audit2allow 把拒绝转成模块

**怎么做**：当 denial 发生在非标准场景，从审计日志提炼规则。先看最近被拒的 httpd 操作：

```bash
ausearch -c 'httpd' --raw | audit2allow -M my-httpd
semodule -X 300 -i my-httpd.pp
```

也可用更友好的 `sealert -a /var/log/audit/audit.log` 读自然语言建议。生成的 `my-httpd.te` 是策略源，可人工审阅。

**为什么**：`ausearch` 过滤审计、`audit2allow` 生成 `.te` 策略源、`semodule` 编译加载成内核模块。这是「按需开白」的正道，比 `setenforce 0` 安全得多——只放开被拒的那一个具体动作。

**出错怎么办**：没日志说明审计服务未开（`systemctl enable --now auditd`）；生成的模块只解决「已发生」的拒绝，新操作仍可能触发新 denial，需迭代。`audit2allow` 出的规则要人工审——它有时会生成 `allow` 过宽的规则（如允许某个域所有访问），别无脑加载。

## 策略从哪来：默认策略与自定义

SELinux 的策略并非手敲，而是发行版随包提供的「默认策略（selinux-policy 系列）」叠加你的修改。默认策略已经为 httpd、mysqld、named、sshd 等服务定义了合理的类型与布尔值，所以多数场景你只是「开布尔值、打标签」，而不是写新规则。当你用 `audit2allow` 生成模块，本质是修补默认策略没覆盖到的自定义路径——比如把 Web 根目录放在 `/srv` 或用户家目录这类非标准位置。这也解释了为什么「关掉 SELinux」代价很大：你丢掉的不是某条规则，而是一整套针对系统服务的最小权限基线，任何服务被攻陷都能横向移动。生产环境正确做法是把自定义需求固化成 `semanage fcontext`/`boolean`/`port` 与可选的本地策略模块，让系统重启后依然生效，而不是用 `setenforce 0` 掩盖问题。理解「默认策略 + 你的增量」这一模型，SELinux 就从玄学变成可管理的配置。

## 踩坑

- **chcon 改完没 semanage fcontext**：重启或 `restorecon` 后标签回退，服务再次被拒。永久化必须 `semanage fcontext -a` + `restorecon`，而非裸 `chcon`。
- **换了端口忘打端口标签**：httpd 监听 888，`semanage port -a -t http_port_t -p tcp 888` 漏了，报绑定失败但端口空闲——典型 SELinux 端口拦截。
- **家目录建 Web 内容忘开布尔值**：`DocumentRoot` 指向 `/home/user/site`，忘了 `setsebool -P httpd_read_user_content on`，访问 403。
- **audit2allow 无脑加载**：生成的模块可能过宽，埋权限隐患。加载前务必看 `my-httpd.te` 内容，确认只放开必要动作，必要时手工收窄。
- **disabled 后直接改 enforcing**：未先 `autorelabel`，大量文件标签缺失，系统功能异常。应走 `permissive` 过渡并打标。

把 SELinux 当成「服务的最小权限沙箱」来对待，思路就清晰了：每个守护进程只能碰策略允许的资源，越界即拒。排错不是关沙箱，而是告诉沙箱「这个目录、这个端口、这个行为是被允许的」。日常维护建议把常用改动写成脚本：`semanage fcontext` 打标签、`setsebool` 开布尔、`semanage port` 加端口，一键复现，避免手动操作遗漏导致重启后复发。这样 SELinux 就从负担变成可版本化、可审计的安全资产。遇到陌生 denial，优先走「`sestatus` 确认模式 → `ausearch` 看哪条拒绝 → `getsebool` 看相关布尔 → `semanage` 看标签与端口」的顺序，八成问题能在前两步定位，不必动辄 `audit2allow` 生成过宽规则。真正需要自定义策略时，也先审阅生成的 `.te` 源，确认只放开必要动作，而不是一股脑加载。长期看，把 SELinux 维持在 enforcing 才是生产应有的状态。

## 速查

```bash
getenforce; setenforce 0            # 临时排错
semanage fcontext -a -t httpd_sys_content_t "/path(/.*)?"; restorecon -Rvv /path
setsebool -P httpd_read_user_content on
semanage port -a -t http_port_t -p tcp 888
ausearch -c 'httpd' --raw | audit2allow -M my-httpd; semodule -X 300 -i my-httpd.pp
```
