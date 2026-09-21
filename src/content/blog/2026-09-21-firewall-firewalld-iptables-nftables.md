---
title: 防火墙三件套：firewalld、iptables 与 nftables 怎么选怎么用
description: 理清 firewalld 区域模型、iptables 四表五链、nftables 原子规则集三者的关系与边界，给出 rich-rule、端口转发、SNAT 与持久化的实战命令，并标注常见排错点，重点说明生产环境如何取舍以及临时规则怎样转永久以免重启丢失配置。
tags: [Linux, 防火墙, 网络安全]
pubDate: 2026-09-21
---

Linux 防火墙看似有三套工具在打架：firewalld、iptables、nftables。其实它们分层清晰——nftables 是内核真正执行的引擎，iptables 是它之上的经典命令行，firewalld 是面向运维的「动态区域」封装。理解这一层关系，才不会被「该用哪个」困住，也不会在排错时对着错误的工具发呆。

## firewalld 的区域模型

**怎么做**：firewalld 用「区域（zone）」把网络接口按信任级别分组，每个 zone 预置一组放行的服务/端口。常见区域有 `drop`（全丢，只收本机主动出的回包）、`block`（拒绝并返回 icmp-host-prohibited）、`public`（默认，只放 22/80/443 等少数）、`trust`（几乎全放）。把服务加进 zone 并持久化：

```bash
firewall-cmd --zone=public --add-service=http --permanent
firewall-cmd --zone=public --add-port=8080/tcp --permanent
firewall-cmd --reload
```

查看当前活动区域与某 zone 的全部规则：

```bash
firewall-cmd --get-active-zones
firewall-cmd --list-all --zone=public
```

把某张网卡绑定到指定 zone：

```bash
firewall-cmd --zone=public --change-interface=eth0 --permanent
```

**为什么**：区域化的好处是「按网卡定策略」。比如连接不可信公网的网卡归入 `public`（只放 22/80/443），内网网卡归入 `trust`（默认放行）。`--permanent` 写盘、`--reload` 生效；不加 `--permanent` 只改运行时（runtime），firewalld 重启即丢。

**出错怎么办**：忘了 `--permanent` 又重启了 firewalld，规则全没。补救是把运行时规则落盘：`firewall-cmd --runtime-to-permanent`。接口没绑到预期 zone，先 `firewall-cmd --get-active-zones` 确认，再 `change-interface`。

## 富规则与端口转发

**怎么做**：当「允许服务」不够精细时，用富规则（rich-rule）表达「限速、限定源地址、记录日志、端口映射」。限制 SSH 每秒只接受 1 个新连接，防暴力破解：

```bash
firewall-cmd --add-rich-rule='rule service name="ssh" limit value="1/m" accept' --permanent
```

限定源地址才放行某端口：

```bash
firewall-cmd --add-rich-rule='rule family=ipv4 source address=192.168.1.0/24 port port=3306 protocol=tcp accept' --permanent
```

把外网 80 转发到内网某主机的 8080：

```bash
firewall-cmd --add-forward-port=port=80:proto=tcp:toport=8080:toaddr=192.168.1.20 --permanent
```

记录被拒的 SSH 试探：

```bash
firewall-cmd --add-rich-rule='rule service name="ssh" log prefix="ssh-deny:" level="warning" drop' --permanent
```

**为什么**：`limit value="1/m"` 是令牌桶，分钟级限流比单纯 `drop` 更友好——合法管理员不会因手抖被锁死，攻击者却被大幅稀释。端口转发本质是目标 NAT（DNAT），需要内核转发开关配合（见下）。`log` 动作把匹配包写进 journal，便于事后审计。

**出错怎么办**：转发不生效，先确认 `sysctl net.ipv4.ip_forward=1` 已开，且源 zone 开启了 `masquerade`（SNAT 让回包能回到客户端）：

```bash
sysctl net.ipv4.ip_forward=1
firewall-cmd --add-masquerade --permanent
```

`masquerade` 没开时，内网回包源地址不对，客户端收不到响应，表现就是「连接建立但无数据」。

## iptables 四表五链

**怎么做**：经典 iptables 直接操作规则链。五个内置链：`PREROUTING`、`INPUT`、`FORWARD`、`OUTPUT`、`POSTROUTING`；常用四表：`filter`（过滤，默认）、`nat`（地址转换）、`mangle`（改包标记）、`raw`（连接追踪豁免）。放行 SSH 与 80 并默认拒绝：

```bash
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -j ACCEPT
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -P INPUT DROP
```

做 SNAT 让内网出网：

```bash
iptables -t nat -A POSTROUTING -s 192.168.1.0/24 -j MASQUERADE
```

**为什么**：`ESTABLISHED,RELATED` 这条必须放在 `DROP` 策略之前，否则本机主动发起的连接（如 `yum` 下载、DNS 查询）的回包会被自己挡掉，表现成「能 ping 通但啥服务都用不了」。`-t nat` 的 `POSTROUTING` 才是真正做源地址转换的地方；`filter` 表看不到 NAT 链。

**出错怎么办**：规则配乱了用 `iptables -F` 清空（注意默认策略若已是 DROP，先 `-P INPUT ACCEPT` 再清，避免把自己踢下线）。iptables 规则默认不持久，RHEL 系用 `service iptables save` 或写 `/etc/sysconfig/iptables`；Debian 系用 `iptables-persistent`。

## nftables 原子规则集

**怎么做**：nftables 用「表—链—规则」结构，配置以文件形式整体加载，避免逐条增删的竞态。建表加链并放行 SSH：

```bash
nft add table inet filter
nft add chain inet filter input '{ type filter hook input priority 0; }'
nft add rule inet filter input tcp dport 22 accept
```

更稳妥的是写配置文件后整体应用：

```bash
nft -f /etc/nftables/ruleset.conf
```

**为什么**：`nft -f` 是「事务式」加载——要么整份生效，要么完全不生效，不会出现「加载到一半内核状态错乱」。`inet` 族同时覆盖 IPv4 与 IPv6，省去各写一套。规则可读性强，例如 `nft add rule inet filter input ip saddr 192.168.1.0/24 accept`。

**出错怎么办**：`nft list ruleset` 查看当前全部规则；排错时先确认系统实际用的是 nftables 而非 legacy iptables（`iptables --version` 显示 `nf_tables`）。两者不应混用同一套规则——开了 nftables 后老的 `iptables` 命令其实是兼容层，直接改 nftables 更清晰。

## 三者关系与选型

| 工具 | 定位 | 适合场景 |
| :--- | :--- | :--- |
| firewalld | 动态区域、服务化封装 | 常规服务器、快速改策略、桌面 |
| iptables | 经典命令行（nf_tables 兼容层） | 老脚本、精细逐链控制、排错 |
| nftables | 新一代内核引擎 | 新部署、性能与原子性要求高 |

**为什么**：它们最终都落到内核 `nf_tables` 子系统（即便你敲 `iptables`，底层也是 nf_tables 后端）。生产新机器优先 firewalld（交互友好）或 nftables（脚本化强）；维护老环境时读懂 iptables 四表五链仍有必要，因为大量历史资料与脚本仍以它表达。

## 状态防火墙与连接追踪

状态防火墙的核心是连接追踪（conntrack）：内核为每条连接维护一张状态表，首包触发「新建（NEW）」，后续包按已有状态快速放行（ESTABLISHED/RELATED）。这正是我们只需在 INPUT 链放行这两个状态、却不必为每个回包单独写规则的原因——回包被 conntrack 识别为「已允许连接的后续流量」，直接放过。conntrack 表有容量上限（由内存与 `nf_conntrack_max` 决定），高并发或遭遇 SYN flood 时可能表满而丢包，此时需要调大表项上限或开启 SYN cookie 缓解。理解这一点，就不会把防火墙当成静态 ACL，而是「有状态的会话管理器」。firewalld 的富规则同样建立在状态之上，例如 `limit` 限速本质是对匹配状态的包做令牌桶计数，而不是无差别限流；`log` 动作也只是对命中包记一笔，不影响放行/拒绝的判决。排查「为什么规则不生效」时，先想清楚这条包处于连接的哪个阶段（NEW 还是已建立），往往就找到了答案。

此外，firewalld 的「运行时」与「永久」两套配置也建立在状态之上：`--permanent` 改的是磁盘上的 zone 定义，`reload` 时重新加载进内核；不加 `--permanent` 的改动活在运行时，重启即失。很多人排错时只在运行时加了一条规则验证了「通了」，却忘了落盘，重启后问题复现。养成「改完立刻 `--runtime-to-permanent`」或写 `--permanent` 的习惯，能省掉大量重复排查。

## 踩坑

- **SSH 限速规则没持久化**：`--add-rich-rule` 不加 `--permanent`，重启 firewalld 后限速消失，爆破防护形同虚设。养成「加完就 `--runtime-to-permanent`」的习惯。
- **drop/block 区域加了服务却无效**：`drop` 与 `block` 区域语义是「默认拒绝」，即便加服务也可能因匹配顺序不生效；需要真正放行的服务应放进 `public` 等允许型区域，或显式写 rich-rule `accept`。
- **端口转发需 ip_forward + masquerade**：只加 `forward-port` 不开发内核转发和 SNAT，包转过去了回不来，客户端永远卡在「等待响应」。
- **iptables 与 nftables 混用**：一边 `iptables -A` 一边 `nft`，规则互相覆盖看不懂。确定一套内核后端，统一工具，排错只看一处。
- **iptables -F 把自己踢下线**：清空前没把默认策略改回 ACCEPT，SSH 会话直接断。远程操作时务必先 `iptables -P INPUT ACCEPT` 再 `-F`。

## 速查

```bash
# firewalld
firewall-cmd --add-service=http --permanent; firewall-cmd --reload
firewall-cmd --add-rich-rule='rule service name="ssh" limit value="1/m" accept' --permanent
firewall-cmd --add-forward-port=port=80:proto=tcp:toport=8080:toaddr=192.168.1.20 --permanent
sysctl net.ipv4.ip_forward=1; firewall-cmd --add-masquerade --permanent
firewall-cmd --runtime-to-permanent
# iptables
iptables -A INPUT -p tcp --dport 22 -j ACCEPT; iptables -P INPUT DROP
# nftables
nft add table inet filter; nft -f /etc/nftables/ruleset.conf; nft list ruleset
```
