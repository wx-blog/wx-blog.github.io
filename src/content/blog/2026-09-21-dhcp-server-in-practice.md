---
title: DHCP 服务实战：DORA 交互、地址池与 MAC 绑定
description: 用 kea-dhcp4 讲清 DHCP 的 DORA 四次交互与租约续期时机，配出动态地址池与 option-data，再用 reservations 做 MAC 绑定固定 IP，并附抓包解读与常见排错，适合实验室或内网批量装机时交付可复现的网络参数。
tags: [Linux, DHCP, 网络服务]
pubDate: 2026-09-21
---

DHCP 让一台服务器自动给成百上千台客户端发 IP、网关、DNS，而不必逐台手工配。现代 RHEL 系推荐 kea-dhcp4（ISC DHCP 的继任者），配置是 JSON。理解 DORA 流程与租约计时，才能解释「为什么客户端拿到的不是我预期的地址」。

## DORA 交互与租约计时

**怎么做**：客户端获取地址走 DORA 四步：Discover（广播找服务器）→ Offer（服务器回可用地址）→ Request（客户端确认要这个）→ ACK（服务器最终确认）。租约不是「一锤子买卖」，有续期机制：

- 到租期 **50%**：客户端单播 Request 续期，成功则租期重置；
- 到 **87.5%**（T2）仍未续上：客户端转广播，向任意服务器 Request；
- 超过 100%：地址释放，重新走 DORA。

**为什么**：短租约让地址池能快速回收（适合终端频繁变动的网络），长租约减少广播与续期流量（适合稳定环境）。50%/87.5% 的两次续期窗口，保证在服务器短暂不可达时客户端不至于立刻掉线。

**出错怎么办**：客户端租约时间对不上预期，检查配置里的 `renew-timer`（默认 50%）、`rebind-timer`（默认 87.5%）、`valid-lifetime`。抓包确认续期是否发出：

```bash
ss -anput | grep dhcp
tcpdump -i any port 67 or port 68
```

## kea-dhcp4 动态地址池

**怎么做**：kea 的核心配置在 `/etc/kea/kea-dhcp4.conf`，一个 `subnet4` 定义网段、地址池与选项：

```json
{
  "Dhcp4": {
    "subnet4": [
      {
        "subnet": "192.168.1.0/24",
        "pools": [ { "pool": "192.168.1.100 - 192.168.1.200" } ],
        "option-data": [
          { "name": "routers", "data": "192.168.1.1" },
          { "name": "domain-name-servers", "data": "192.168.1.1, 8.8.8.8" },
          { "name": "domain-name", "data": "lab.com" }
        ],
        "renew-timer": 1800,
        "rebind-timer": 3150,
        "valid-lifetime": 3600
      }
    ]
  }
}
```

改完让 kea 重新加载配置（不中断现有租约）：

```bash
systemctl reload-or-restart kea-dhcp4.service
```

**为什么**：`routers` 即客户端默认网关，`domain-name-servers` 是 DNS，`domain-name` 是搜索域——这些 `option-data` 才是客户端「能上网、能解析」的关键，光给 IP 不够。`reload-or-restart` 比 `restart` 温和，尽量保留运行态。

**出错怎么办**：服务起不来几乎都是 JSON 语法错（最常见是多了逗号、括号不配对）。先用 `kea-dhcp4 -t /etc/kea/kea-dhcp4.conf` 校验（若支持），或看 `journalctl -u kea-dhcp4` 报的第几行。客户端拿不到地址，先确认服务器在监听 67：

```bash
ss -anput | grep dhcp
```

## MAC 地址绑定（固定 IP）

**怎么做**：想让某台设备永远拿到同一 IP，在 `subnet4` 里加 `reservations`，用 `hw-address` 绑定 MAC：

```json
"reservations": [
  {
    "hw-address": "52:54:00:11:22:33",
    "ip-address": "192.168.1.50",
    "hostname": "printer.lab.com"
  }
]
```

绑定后该 MAC 无论何时请求，都只拿到 `192.168.1.50`，且可附带 `hostname`。

**为什么**：打印机、服务器、AP 这类需要固定寻址的设备，用保留地址比手工静态配更集中、更好管理——所有 IP 规划都在 DHCP 服务器一处。绑定优先级高于地址池，所以保留地址即便落在池区间内也不会被分配给别人。

**出错怎么办**：绑定没生效，先确认 `hw-address` 格式是 `:` 分隔且大小写一致；客户端若是手机/笔记本开了「随机 MAC」，每次请求 MAC 不同，绑定必然失效——关掉随机 MAC 或用 DUID 而非 hw-address（kea 支持 `duid` 预留）。

## 抓包解读

**怎么做**：在服务器抓 DHCP 流量，看四步交互与 offered 地址：

```bash
tcpdump -i any port 67 or port 68 -v
```

**为什么**：客户端初始是广播（255.255.255.255:67→68），服务器单播回 Offer。若你只看到 Discover 没有 Offer，说明服务器没收到或没回应（防火墙/子网不对）；若看到 Offer 但客户端不 Request，可能是网络上还有另一台 DHCP 服务器抢答。

**出错怎么办**：跨网段分配需 DHCP 中继（relay agent），在网关上把 67 转发到服务器；否则广播到不了服务器，客户端永远拿不到地址。

## 地址冲突与免费 ARP

DHCP 分配的地址理论上不重复，但现实里「静态 IP 与地址池重叠」「两台 DHCP 服务器抢活」「客户端随机 MAC」都会制造冲突。Linux 客户端拿到地址后会发免费 ARP（gratuitous ARP）宣告「这个 IP 是我的」，若网上已有同 IP 会收到冲突提示并放弃该地址、重新申请。服务器侧则要确保 `reservations` 落在 pools 之外或明确优先，且同一广播域只应有一台权威 DHCP（或用 relay 收敛到一台），否则客户端可能从错误的服务器拿到错误网段的地址。当客户端拿到「不对劲」的地址（比如 `169.254` 开头的 APIPA 链路本地地址），基本说明 DORA 全程失败——没 Offer 也没 ACK，系统退而求其次用自动私有地址，此时应优先排查服务器是否收到 Discover、防火墙是否挡 67、网段是否跨了需要中继。地址冲突排查的捷径是：先在服务器端 `ss` 确认 67 在监听，再在客户端 `tcpdump` 看四步交互卡在哪一步，最后查是不是有第二台 DHCP 在「抢答」。

此外，kea 的地址分配还受「租约数据库」影响——单台场景用默认 memfile 即可，但务必定期备份租约文件，避免重启后所有客户端被迫重新申请、造成短暂拥塞。若要做多服务器高可用分配，则需共享同一后端（如 mysql/pgsql），否则各服各分各的池、容易撞车。把租约库当持久数据对待，是 DHCP 运维的基本功。

## 踩坑

- **客户端拿到旧地址**：换池后客户端仍用旧租约，直到 50%/87.5% 续期点才更新。想立即生效可在客户端 `dhclient -r` 释放后重申请，或缩短 `valid-lifetime` 再 reload。
- **JSON 多逗号/括号错**：kea 直接拒绝启动。`kea-dhcp4 -t` 校验配置，或 `journalctl` 看报错行号，逐个修逗号。
- **防火墙挡 67/68**：服务器没放行 UDP 67，客户端 Discover 石沉大海。确认 `firewall-cmd --add-service=dhcp --permanent`。
- **中继没配跨子网失败**：客户端与服务器不在同一广播域，缺 DHCP 中继，广播到不了服务器。需在中间路由器/交换机开 relay 指向服务器 IP。
- **随机 MAC 导致绑定失效**：终端开了隐私 MAC，每次 MAC 不同，reservation 永远不匹配。改用 DUID 预留或关闭随机 MAC。

DHCP 服务上线前，务必先用 `tcpdump` 抓一次完整的 DORA，确认四步都出现、Offer 的地址在你预期的池里。很多「客户端拿错地址」其实是网络上还有另一台 DHCP（比如路由器自带的），它抢先回了 Offer。解决办法是统一 DHCP 入口：只在核心交换机做 relay 指向你的 kea，关掉其他设备的 DHCP 服务。上线后保留租约备份，并把 `valid-lifetime` 设得与网络变更频率匹配——终端流动性高的环境用短租约，稳定环境用长租约，既省广播又便于回收。最后提醒，`reservations` 的 MAC 必须与客户端实际发出的一致，手机与笔记本的「随机 MAC」功能会让绑定永远不命中，这类设备要么关随机 MAC，要么改用 DUID 预留。把这些前置检查做足，DHCP 才能真正「无人值守」地稳定运转。

## 速查

```bash
systemctl reload-or-restart kea-dhcp4.service
ss -anput | grep dhcp
tcpdump -i any port 67 or port 68 -v
# reservation 用 hw-address 绑定固定 IP
# 校验 JSON：kea-dhcp4 -t /etc/kea/kea-dhcp4.conf
```
