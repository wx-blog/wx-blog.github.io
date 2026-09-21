---
title: IPv6 深潜：ICMPv6、NDP 与 SLAAC 地址自动配置
description: 讲清 IPv6 下 ICMPv6 与邻居发现 NDP 的替代角色、SLAAC 无状态地址生成的完整流程与 M/O/A 标志位组合，用 radvd 与 kea-dhcp6 实操，帮助在纯 IPv6 或双栈环境把地址规划、无状态配置与排错一次讲透。
tags: [Linux, IPv6, 网络]
pubDate: 2026-09-21
---

IPv6 不是「更长的 IPv4」。它最大的变化之一是把 ARP、DHCP 的部分职责，以及路由发现，统一收进了 ICMPv6 和邻居发现协议（NDP）。理解了 NDP，就理解了 IPv6 主机是怎么「自己长出地址、自己找到网关」的。

## ICMPv6：被 IPv6 依赖的「大一统」协议

**怎么做**：在 IPv6 里，ICMPv6（Next Header 值 58）承载的远不止 `ping`——邻居不可达检测、路径 MTU 发现、路由器发现、重复地址检测全都靠它。放行防火墙时必须允许 `ipv6-icmp`，而不是当成「ping 噪音」一封了之：

```bash
firewall-cmd --add-protocol=ipv6-icmp --permanent
firewall-cmd --add-service=dhcpv6 --permanent
```

抓包观察 NDP 报文：

```bash
tcpdump -i any icmp6
```

**为什么**：IPv6 没有 ARP（那是 IPv4 链路层的事），NDP 用 ICMPv6 的 NS/NA 替代；也没有 IPv4 那种「重定向网关」的广播，路由发现用 RS/RA。所以**一旦把 ipv6-icmp 整类丢弃，整台主机的 IPv6 通信会直接断网**——它和 IPv4 里「禁 ICMP 还能 TCP」完全不同。

**出错怎么办**：IPv6 配了地址却不通，先查防火墙是不是把 `ipv6-icmp` 禁了。`tcpdump -i any icmp6` 看不到 RA，说明网关没发或中间被过滤。

## NDP：IPv6 的「ARP + 路由发现」

**怎么做**：NDP 用四类报文完成链路层寻址与网关发现：

| 报文 | 方向 | 作用 |
| :--- | :--- | :--- |
| RS（Router Solicitation） | 主机 → 组播 | 主动问「网关在哪」 |
| RA（Router Advertisement） | 网关 → 组播 | 周期性/回应地通告前缀、网关、标志位 |
| NS（Neighbor Solicitation） | 主机 ↔ 主机 | 查某 IPv6 对应的 MAC（替代 ARP） |
| NA（Neighbor Advertisement） | 主机 ↔ 主机 | 回应 MAC 或宣告地址变更 |

主机用「请求节点组播地址」`FF02::1:FFXX:XXXX` 精准询问，避免 IPv4 那种全网 ARP 广播风暴。查看邻居表：

```bash
ip -6 neigh
ip -6 route
```

**为什么**：请求节点组播把「查一个邻居」的代价从「惊动全网」降到「只惊动目标主机所在的极小群」，是 IPv6 在大规模链路上的效率改进。

**出错怎么办**：`ip -6 neigh` 里某地址一直是 `INCOMPLETE`（解析不出 MAC），查对端是否在线、链路是否通；`ip -6 route` 里没有默认路由 `default via ... dev ...`，说明没收到 RA。

## SLAAC：无状态地址自动配置

**怎么做**：SLAAC 让主机「自己生成地址」，流程是：先有链路本地地址（LLA，`FE80::/10`）→ 做重复地址检测（DAD）→ 收 RA 拿到全球单播前缀 → 用 EUI-64 或稳定隐私地址拼出 GUA。RA 里的标志位决定行为：

| 标志 | 含义 |
| :--- | :--- |
| M（Managed） | 1=用 DHCPv6 拿地址（有状态） |
| O（Other） | 1=用 DHCPv6 拿其他配置（DNS 等） |
| A（Autonomous） | 1=允许 SLAAC 自己拼地址 |

四种典型组合：仅 A=纯 SLAAC；A+M= SLAAC 地址 + DHCPv6 其他；M 无 A=纯 DHCPv6；O 配合 A= SLAAC 地址 + DHCPv6 下发 DNS。

**为什么**：EUI-64 把 MAC 拆开塞进 `FFFE` 生成接口标识，稳定可预测但泄露 MAC；现代系统默认用「稳定隐私地址（stable-privacy）」随机生成，兼顾稳定与隐私。SLAAC 不需要服务器记租约，所以叫「无状态」。

**出错怎么办**：主机拿到 `FE80::` 却没 GUA，通常是 RA 里 `A` 位没开或前缀为 `::/64` 无效。地址冲突时 DAD 失败，地址进入 `tentative`/`duplicate` 状态，需换接口标识。

## 实操：radvd + kea-dhcp6

**怎么做**：网关用 `radvd` 发 RA，让客户端 SLAAC 拿到地址；需要下发 DNS 时再开 `kea-dhcp6` 做「其他配置」。radvd 配置：

```bash
vim /etc/radvd.conf
# interface eth0 {
#   AdvSendAdvert on;
#   AdvManagedFlag off;      # M=0
#   AdvOtherConfigFlag on;   # O=1，用 DHCPv6 拿 DNS
#   prefix 2001:db8:1::/64 { AdvAutonomous on; AdvOnLink on; };
# }
systemctl enable --now radvd
```

kea-dhcp6 下发 DNS 服务器与搜索域：

```bash
vim /etc/kea/kea-dhcp6.conf
# "subnet6": [ { "subnet": "2001:db8:1::/64",
#   "option-data": [ {"name":"dns-servers","data":"2001:db8:1::1"},
#                    {"name":"domain-search","data":"lab.com"} ] } ]
systemctl enable --now kea-dhcp6.service
```

**为什么**：纯 SLAAC（A 位开、M/O 关）主机是拿不到 DNS 服务器地址的——SLAAC 只给前缀。要让客户端知道去哪解析域名，要么开 O 位走 DHCPv6 拿「其他配置」，要么在 RA 里带 RDNSS 选项。把地址分配（SLAAC）与信息下发（DHCPv6）职责分开，是 IPv6 的设计哲学。

**出错怎么办**：客户端 `resolv.conf` 没 DNS，检查 RA 的 O 位与 kea-dhcp6 是否在跑、防火墙是否放 `dhcpv6` 服务（客户端用 `systemctl status kea-dhcp6` 看租约）。

## 唯一本地地址 ULA 与全球地址的分工

除了全球单播地址（GUA，公网/实验段如 `2001:db8::/32`），IPv6 还有唯一本地地址（ULA，`FC00::/7`，常写 `fd00::/8`）用于内网通信，类似 IPv4 的私网段但不与公网路由。二者分工清晰：对外服务用 GUA（需要公网可达与 DNS AAAA 记录），内部设备间、跨站点 VPN 内的固定寻址用 ULA（不依赖公网前缀、运营商重编号时不影响内网）。SLAAC 默认只发 GUA；若需要 ULA 并存，RA 里同时宣告两段前缀即可，主机会各生成一个地址并分别用于对应场景。注意 ULA 不会自动获得默认路由（它本就不是默认出口），所以「内网固定 + 外网 SLAAC」的组合很常见。理解这点能避免「为什么我配了 fd00 地址却上不了网」的困惑——ULA 本来就不是用来出网的，它只在你的管理域内有效。规划 IPv6 地址时，把「可达性」和「稳定性」两个目标拆给 GUA 与 ULA，网络才好维护。

另外，IPv6 没有 NAT 的刚需（地址充足），但这不意味着不需要防火墙——相反，由于每台主机都有全球可达的 GUA，入口过滤（反 spoofing）与状态防火墙比以前更重要。很多运维惯性地把 IPv6 当 IPv4 对待去套 NAT，反而丢了端到端透明的优势。正确做法是靠无状态前缀下发加状态防火墙，而非 NAT 遮蔽。

## 踩坑

- **IPv6 转发没开，RA 不发**：网关要发 RA 必须先 `sysctl net.ipv6.conf.all.forwarding=1`，否则 radvd 起不来或 RA 被内核吞掉。
- **纯 SLAAC 没有 DNS**：只在 RA 开 A 位，主机有地址却不知道 DNS 服务器。补 O 位 + DHCPv6，或 RA 带 RDNSS。
- **防火墙挡 ipv6-icmp**：按 IPv4 习惯把 ICMP 全禁，结果 NDP 全断、IPv6 整体不通。必须显式放行 `ipv6-icmp`。
- **隐私地址导致 ACL 失效**：用稳定隐私地址时，主机出口地址会变，基于固定地址的防火墙/日志规则失效。需要固定地址时禁用隐私扩展或绑定 EUI-64。
- **M/O 位配反**：想要有状态地址却 M 位关，客户端只 SLAAC 不自建租约；想要纯 SLAAC 却 M 位开，客户端去 DHCPv6 要地址反而拿不到。

IPv6 的普及难点往往不在协议本身，而在运维习惯：地址太长不愿看、习惯了 IPv4 的 NAT 思维、忘了 ICMPv6 不能封。实际落地时，建议先在内部网络用 SLAAC 跑通地址与路由，再逐步接入公网前缀；监控与日志里把 IPv6 流量单独分出来看，避免「以为没流量其实是配置错了」。NDP 是 IPv6 的命门，任何「时通时不通」先怀疑 RA 是否稳定、链路是否真通，再怀疑地址本身。另外，IPv6 默认开启隐私扩展会让来源地址多变，做基于 IP 的审计或访问控制时要意识到这一点，必要时为服务器固定接口标识或显式绑地址。把 SLAAC 的便利与地址管理的可控结合起来，IPv6 才真正可用而非只是配着看。

## 速查

```bash
sysctl net.ipv6.conf.all.forwarding=1
firewall-cmd --add-protocol=ipv6-icmp --permanent; firewall-cmd --add-service=dhcpv6 --permanent
tcpdump -i any icmp6
ip -6 neigh; ip -6 route
# radvd.conf: AdvSendAdvert on; AdvManagedFlag off; AdvOtherConfigFlag on; prefix ... { AdvAutonomous on }
```
