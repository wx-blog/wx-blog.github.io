---
title: bond 与 bridge：Linux 链路聚合与软件网桥
description: 用 nmcli 创建 active-backup 与 802.3ad 绑定实现高可用与带宽叠加，读懂 /proc/net/bonding 的故障转移状态，再建软件网桥 bridge，说明 bond 之上叠 bridge 的组合用法与排错，适合需要链路冗余或汇聚带宽的服务器与虚拟化宿主机。
tags: [Linux, 网络, bond]
pubDate: 2026-09-21
---

服务器网口不能「单点」。bond（绑定）把多块物理网卡聚合成一个逻辑口，要么做高可用（一块坏了另一块顶上），要么做带宽叠加；bridge（网桥）则是软件实现的二层交换机，是虚拟机和容器联网的基础。两者常常组合：在 bond 之上建 bridge。

## bond 模式与创建

**怎么做**：bond 有多种模式，用 `nmcli` 创建 `active-backup`（主备高可用）：

```bash
nmcli connection add type bond con-name bond0 ifname bond0 mode active-backup
nmcli connection add type ethernet slave-type bond master bond0 con-name bond0-port1 ifname ens160
nmcli connection add type ethernet slave-type bond master bond0 con-name bond0-port2 ifname ens192
nmcli connection mod bond0 bond.options "mode=active-backup,primary=ens160,fail_over_mac=active"
nmcli connection up bond0
```

想做带宽叠加/负载均衡用 `802.3ad`（LACP），需交换机侧也配聚合：

```bash
nmcli connection mod bond0 bond.options "mode=802.3ad,lacp_rate=fast"
```

**为什么**：常见模式含义——`balance-rr`(0) 轮转发包、`active-backup`(1) 主备、`balance-xor`(2) 按哈希选口、`broadcast`(3) 全发、`802.3ad`(4) LACP 动态聚合、`balance-tlb`(5)/`balance-alb`(6) 自适应。主备模式最简单也最稳，适合「不能断」的管理网；LACP 需要交换机配合，适合需叠加带宽的业务网。

**出错怎么办**：`nmcli connection show` 确认 slave 都 `up`；`ip addr show bond0` 应看到聚合后的 MAC 与 IP。`fail_over_mac=active` 让备口接管时改用活动口的 MAC，避免交换机 MAC 表震荡。

## active-backup 故障转移观察

**怎么做**：创建后查看绑定状态，重点看哪个口是 active、链路是否 up：

```bash
cat /proc/net/bonding/bond0
```

输出里 `Currently Active Slave` 指出当前主口，`MII Status: up` 表示链路正常。模拟故障：

```bash
ip link set ens160 down     # 拔掉主口
cat /proc/net/bonding/bond0 # 应看到 Active Slave 切到 ens192
```

**为什么**：bond 靠 MII 状态检测链路。`primary=ens160` 指定优先口；主口 down 后内核自动把流量切到备口，对上层应用透明（IP/MAC 不变或按 `fail_over_mac` 策略切换）。这正是高可用的价值。

**出错怎么办**：切换不生效，查 `/proc/net/bonding/bond0` 里两个 slave 的 `MII Status` 是否都 `up`；若备口显示 `down`，可能是物理线或交换机端口问题，而非 bond 配置错。

## 软件网桥 bridge

**怎么做**：bridge 让多个接口（含虚拟机 tap、容器 veth）在同一二层互通，等价于一台软交换机。用 `nmcli` 创建：

```bash
nmcli connection add type bridge con-name bridge0 ifname bridge0
nmcli connection mod bridge0 bridge.stp on          # 开生成树防环
nmcli connection add type bridge-slave master bridge0 con-name bridge0-port1 ifname ens224
nmcli connection up bridge0
```

把虚拟机/容器的接口挂到 bridge0，它们就和物理网段二层互通。

**为什么**：KVM、libvirt、Docker 默认都建 bridge 让 Guest 直连物理网络。STP（生成树）防止环路广播风暴，多桥互联时务必开启。`bridge0` 本身可配 IP，作为该网段的网关接口。

**出错怎么办**：bridge 上设备不通，先 `bridge link` 看成员口是否 attach；`ip addr show bridge0` 看桥有没有 IP。`brctl show`（若装了 bridge-utils）也能看拓扑。

## bond 与 bridge 的组合选用

**怎么做**：高可用场景常把 bridge 建在 bond 之上——既冗余又供虚拟机共享：

```bash
# 先建 bond0（active-backup），再把 bridge 的 slave 指向 bond0
nmcli connection add type bridge con-name bridge0 ifname bridge0
nmcli connection add type bridge-slave master bridge0 con-name bridge0-bond con-name bridge0-bond ifname bond0
```

即：物理网卡 → bond0（冗余）→ bridge0（二层交换）→ 虚拟机。

**为什么**：bond 解决「物理链路冗余」，bridge 解决「多设备二层互通」。两者正交，组合起来就是虚拟化宿主机的标准联网模型：对外不怕单口坏，对内多 Guest 共享一个冗余上联。

**出错怎么办**：组合后不通，分段排查——先确认 bond0 本身能通（挂 IP 测），再在 bridge0 上挂 IP 测，最后挂 Guest 测。哪一层不通就在哪一层查（`/proc/net/bonding`、桥成员、Guest 配置）。

## 绑定与网卡速率、双工协商

bond 把多口聚合成逻辑口，但聚合的上限受物理成员制约：active-backup 模式下总带宽等于单口（只高可用、不叠加），真正的带宽叠加要靠 802.3ad（LACP）且多流才能分到不同口——单条 TCP 流再怎么聚合也只会走一个口。成员网卡的速率/双工必须一致，否则 bond 会以最慢成员为准，甚至因协商异常导致 flapping（反复切换主备）。用 `ethtool ens160` 可看每张成员口的速率与双工状态；若发现 bond0 速率只有 1G 而成员有 10G，先查是不是某口协商到了低速或网线/交换机端口限速。此外，bond 之上再建 bridge 时，IP 与路由应配在 bridge0 而非 bond0，否则会出现「逻辑口有地址但桥不通」的怪象。虚拟化场景里这套「物理口→bond→bridge→虚拟机」的层次务必理顺：bond 解决物理链路冗余，bridge 解决多 Guest 二层互通，两者正交、顺序固定。

运维上建议给 bond 成员口统一命名与描述（如 ens160=上联A、ens192=上联B），并在文档里记下对端交换机端口，故障时能一分钟定位是哪条物理链路断了。最后提醒，LACP 是「双方协商」，交换机端没配聚合口（channel-group / bond 等价）时，服务器端 `mode=802.3ad` 要么起不来、要么只有单口通，排错时要服务器与交换机一起看，而不是只在 Linux 侧找原因。

## 踩坑

- **子接口旧连接冲突**：把 `ens160` 加进 bond 前，它原本可能有独立连接（如 `Wired connection 1`），不删会导致 MAC/IP 冲突、bond 起不来。先 `nmcli connection delete` 旧连接再建 slave。
- **看不到 IP 是没 up**：bond/bridge 建好但 `ip addr` 没 IP，多半是连接没 `up` 或没给 IP。建完务必 `nmcli connection up`，并确认地址配置在 bond0/bridge0 而非物理口上。
- **单口桥 down 全断**：bridge 只挂了一个物理口时，那个口一断整个桥隔离。需要冗余就先在 bond 上建桥，而非裸桥。
- **LACP 交换机没配**：`mode=802.3ad` 但交换机端没做链路聚合，聚合起不来、可能只有单口通或完全不通。服务器与交换机模式必须匹配。
- **MTU 不一致**：bond/bridge 成员 MTU 不同会导致大包丢弃。统一成员与逻辑口的 MTU（如都要 9000 就全设 9000）。

网络绑定的价值在「故障切换对用户透明」，但前提是切换真的快且静默。active-backup 的切换通常在秒级，足够大多数应用；若业务对抖动零容忍，需在交换机与网卡层面配合做更快的检测，比如降低 MII 轮询间隔、用 LACP 的快速收敛。实际交付前，建议做一次真实的「拔线测试」：down 掉主口，观察业务是否中断、`/proc/net/bonding` 是否切到备口、MAC 表是否平稳。只靠配置看起来对，不算真的高可用。另外，bond 之上的 bridge 若承载虚拟机，记得在虚拟机配置里也确认用的是 bridge0 而非直接绑物理口——常见错误是 Guest 直接挂 ens160，导致 bond 的冗余对它完全不生效，物理口一坏 Guest 就掉。把「配置正确」和「实测切换」两件事都做完，冗余才算真正落地。

bond 与 bridge 的组合还有一种常见但容易被忽略的副作用：冗余提升的是「链路可用性」，并不等于「应用零中断」。当主物理口被踢出聚合组、流量切到备用口时，内核只是把发送队列换了一张网卡，已建立的 TCP 连接靠对端重传就能续上，但若应用层自己有短超时或心跳阈值设得很小，仍然可能在这一两秒的切换窗口里误判对端死亡。因此冗余方案上线后，最好用真实业务流量（或至少用长连接压测）做一遍切换演练，确认切换耗时落在应用容忍范围内，而不是只看 `ip link` 状态灯变了就认为万事大吉。另外，bridge 上的 STP 收敛也需要时间，若拓扑里有环或曾发生过广播风暴，收敛期间端口会临时阻塞，这部分延迟同样要计入演练。

## 速查

```bash
nmcli connection add type bond con-name bond0 ifname bond0 mode active-backup
nmcli connection add type ethernet slave-type bond master bond0 con-name bond0-port1 ifname ens160
nmcli connection mod bond0 bond.options "mode=active-backup,primary=ens160,fail_over_mac=active"
cat /proc/net/bonding/bond0
nmcli connection add type bridge con-name bridge0 ifname bridge0; nmcli connection mod bridge0 bridge.stp on
```
