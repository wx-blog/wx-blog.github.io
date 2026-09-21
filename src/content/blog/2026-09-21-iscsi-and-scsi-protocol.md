---
title: iSCSI 从 SCSI 协议到远程块设备挂载
description: 从 SCSI 命令集与传输解耦讲起，理清 Initiator/Target/LUN 与 iSCSI PDU，再用 targetcli 配 Target、iscsiadm 配 Initiator，把远端磁盘分区格式化并持久挂载，并覆盖门户不可达、IQN 认证失败、开机挂载顺序错等典型故障的定位。
tags: [存储, iSCSI, 网络存储]
pubDate: 2026-09-21
---

iSCSI 把「本地硬盘」延伸到以太网，让一台服务器像使用本地盘一样用远程存储。要真正用对，得先理解它底下那套 SCSI 抽象，否则配出来的 Target/ACL/Portal 只是一堆不明所以的命令。它属于 SAN（块存储），与 NAS（文件存储）定位不同。

## 存储架构与 SCSI 协议栈

**怎么做**：先分清三类存储。DAS 是直连本机、扩展位有限；NAS 走 NFS/SMB 提供「文件」级共享；SAN 提供「块设备」级访问，iSCSI 和 FC 都属此类。SCSI 本身不是插槽，而是一套「命令集 + 传输层」分层设计：CDB（Command Descriptor Block，命令描述块）描述「读第 N 块」，传输层决定这封信走 SAS 排线、光纤还是网线。

Linux 里无论本地 SAS 盘、远端 iSCSI 盘还是 FC 盘，最终都进标准 SCSI 驱动层 `sd_mod`，呈现为 `/dev/sdX`。核心角色：

| 角色 | 含义 | iSCSI 中的体现 |
| :--- | :--- | :--- |
| Initiator | 主动发起 I/O 的主机 | TCP 客户端，连 3260 |
| Target | 提供存储的资源方 | 监听 Portal 的「保险箱柜台」 |
| LUN | Target 内的逻辑单元 | 最终映射给主机的「硬盘」 |

**为什么**：SCSI 把「命令」和「怎么传」解耦，所以同一套 `READ(10)`/`WRITE(10)` 命令（操作码 `0x28`/`0x2A`）能在 IP 网络上原样跑——这正是 iSCSI 的价值：SCSI over TCP/IP。对比 FC（光纤，无损低延迟但贵）、FCoE（以太网跑 FC，需无损交换）、NVMe-oF（新一代，更低延迟），iSCSI 胜在复用现有以太网、成本最低。

## iSCSI 协议原理

**怎么做**：iSCSI 把 CDB、数据、状态分别塞进 iSCSI PDU，靠 TCP 保证可靠。关键概念：Portal = `IP:端口`（默认 3260），是 Initiator 的唯一入口；Target 用 IQN（如 `iqn.2026-04.com.lab:server-sdb`）唯一命名；LUN 编号 0~16383，必须映射给特定 Initiator 才可见。登录分发现（Discovery）、登录（Login）、全功能（Full Feature）三阶段，可用 CHAP 校验身份。

**为什么**：Initiator 先 TCP 连 Portal，再在 Login 阶段报出目标 Target 名与自身 IQN，Target 据此查 ACL 决定映射哪个 LUN。谁发起会话谁就是 Initiator，Target 永不主动连。iSCSI PDU 由固定 48 字节的 BHS（基本头部段）+ 可选 AHS + 数据段组成，SCSI 命令（Opcode 0x21）把 CDB 带在 BHS 尾部；读数据时 Target 用 Data-In PDU（0x25）把磁盘数据推给 Initiator。

**出错怎么办**：连不上先看 Portal 的 IP:端口是否通（`telnet 192.168.1.10 3260` 或 `ss -anpt | grep 3260` 在 Target 端）；登录被拒查 IQN 与 ACL 是否匹配（见下）。

## 配置 Target 端

**怎么做**：服务端装 `targetcli`，启 `target` 服务。用交互式 shell 建后端存储、建 Target、绑 LUN、设 ACL 与 Portal：

```bash
dnf -y install targetcli
systemctl enable --now target
targetcli
/> backstores/block create sdb /dev/sdb
/> iscsi create iqn.2026-04.com.lab:server-sdb
/> iscsi/iqn.2026-04.com.lab:server-sdb/tpg1/luns create /backstores/block/sdb
/> iscsi/iqn.2026-04.com.lab:server-sdb/tpg1/acls create iqn.2026-04.com.lab:client-scsi
/> iscsi/iqn.2026-04.com.lab:server-sdb/tpg1/portals delete 0.0.0.0 3260
/> iscsi/iqn.2026-04.com.lab:server-sdb/tpg1/portals create 192.168.1.10 3260
/> saveconfig
```

后端类型有 `block`（整块设备/分区）、`fileio`（文件镜像）、`psc`（直通物理 SCSI）、`ramdisk`（内存盘）。`backstores/block` 直接喂整盘；`fileio` 适合用镜像文件：

```bash
/> /backstores/fileio create file_disk /srv/disk.img 1G write_back=false
/> iscsi/iqn.2026-04.com.lab:server-sdb/tpg1/luns create /backstores/fileio/file_disk
```

改完 `firewall-cmd --add-service=iscsi-target --permanent` 放行 3260。

**为什么**：`acls create` 的 IQN 是客户端「准入名单」，只有 InitiatorName 与之匹配才能看到 LUN；Portal 从 `0.0.0.0` 收缩到具体 IP，可实现管理/数据流量隔离。`saveconfig` 写入 `/etc/target/saveconfig.json`，重启 `target` 服务自动恢复。`write_back=false` 让 fileio 直写、更安全的（但稍慢）。

**出错怎么办**：`targetcli` 里 `ls` 逐级检查 tpg1 下 `acls`/`luns`/`portals` 是否齐备；`saveconfig` 后 `systemctl restart target` 确认配置能 reload。

## 配置 Initiator 并挂载

**怎么做**：客户端装 `iscsi-initiator-utils`，把 `/etc/iscsi/initiatorname.iscsi` 的 `InitiatorName` 改成与 Target ACL 完全一致，再发现、登录：

```bash
dnf -y install iscsi-initiator-utils
systemctl restart iscsid
vim /etc/iscsi/initiatorname.iscsi        # InitiatorName=iqn.2026-04.com.lab:client-scsi
iscsiadm --mode discoverydb --type sendtargets --portal 192.168.1.10:3260 --discover
iscsiadm --mode node --targetname iqn.2026-04.com.lab:server-sdb --portal 192.168.1.10:3260 --login
```

登录后 `lsscsi` 出现新盘（如 `/dev/sdb`），按本地盘流程处理：

```bash
parted /dev/sdb mklabel gpt
parted /dev/sdb mkpart xfs 0% 10%
mkfs.xfs /dev/sdb1
blkid /dev/sdb1                            # 记下 UUID
echo 'UUID="..." /mnt/iscsi xfs _netdev,defaults 0 0' >> /etc/fstab
mkdir /mnt/iscsi && mount -a
```

`set _netdev` 让系统知道这是网络盘，开机先等网络。最后让客户端开机自动登录：

```bash
iscsiadm --mode node --targetname iqn.2026-04.com.lab:server-sdb --portal 192.168.1.10:3260 \
  -o update -n node.startup -v automatic
systemctl enable iscsi
```

**出错怎么办**：`lsscsi` 看不到盘先确认 InitiatorName 与 ACL 一字不差；登录失败查防火墙 `iscsi-target`；`mount -a` 报 SELinux 标签警告属正常，按需 `restorecon` 即可。`discoverydb` 会缓存节点信息，换 IP/重配后记得先 `--logout` 再重新 `--discover`。

## 多路径与高可用思路

单机单口的 iSCSI 仍有单点：要么网口坏，要么存储端单 Portal 故障。生产常做两层冗余：一是存储端暴露多个 Portal（如管理网口 + 数据网口各一个），Initiator 发现后会看到多条路径；二是客户端配 multipath（DM-Multipath），把多条到同一 LUN 的路径聚合成一个设备（如 `/dev/mapper/mpatha`），某条链路断时自动切到另一条，对上层文件系统透明。多 Portal 在 targetcli 里就是 tpg1 下加多个 `portals`；多路径则需启用 device-mapper-multipath 并用 `multipath -ll` 查看路径状态。注意多路径要求存储端同一 LUN 对 Initiator 呈现一致（同一 Serial/WWN），否则会被当成两块不同盘而非冗余路径。iSCSI 的「会话」与「路径」是两个维度：一个会话可含多连接，multipath 则在会话之上再做设备级冗余。真正的关键业务存储，往往是「双交换机 + 双 Portal + multipath」三者齐备，任一环节断了 I/O 都不中断。配置复杂度上升，但换来的是存储链路级别的可用性。

性能上也要提醒：软件 iSCSI 的封装与 TCP 校验和靠主机 CPU，高吞吐场景建议开启网卡卸载（若硬件支持），并把存储流量单独走万兆或隔离网段，避免与业务流量抢带宽、互相抖动。巨型帧（MTU 9000）在 iSCSI 网段能显著降低 CPU 与中断开销，但要求整条链路（网卡、交换机、存储）一致支持，任一环节还是 1500 就会出分片甚至丢包。

## 踩坑

- **InitiatorName 与 ACL 不一致**：Target 端 `acls create` 的是 `client-scsi`，客户端写错一个字符，`--login` 直接失败或登录后看不到 LUN。两端 IQN 必须完全一致（区分大小写）。
- **fstab 漏写 `_netdev`**：远程盘当本地盘挂，开机网络未就绪就 `mount -a`，系统卡在启动界面。网络块设备一律加 `_netdev`。
- **Portal 仍是 0.0.0.0 却期望固定 IP**：默认 `auto_add_default_portal=true` 监听全部 IP，若要隔离数据面，务必先 `portals delete 0.0.0.0 3260` 再 `create` 具体 IP。
- **换 LUN 后客户端不刷新**：新增 fileio LUN 后，客户端要 `iscsiadm ... --logout` 再 `--login`，或重新发现，否则 `lsscsi` 只看到旧设备。
- **discoverydb 缓存旧记录**：改了 Target 的 IP 或 IQN，客户端仍用缓存节点登录失败。删缓存：`iscsiadm -m node -o delete` 再重新 discovery。
- **CHAP 没配但以为配了**：只在 Target 设了 ACL 没开 CHAP，网络内任意知道 IQN 的客户端都能登录。需要防冒名就在 tpg1 下配 `set auth userid/password` 并 `acls` 对应。

iSCSI 交付前，最关键的验证是「重启客户端后远程盘是否自动回来」：确认 initiatorname 一致、`node.startup=automatic`、`fstab` 带 `_netdev`。很多环境平时好用，一重启就卡在挂载网络盘，正是漏了其中一项。性能验收则建议用 `fio` 或 `dd` 测一下顺序与随机 IO，确认多路径真的在分担流量、CPU 软封装没成为瓶颈，再正式上线承载业务数据。存储这类「看起来通、实则脆弱」的服务，最怕的就是只做了「能挂载」这一项验证。把「自动重连、多路径切换、性能达标」三项都测过，iSCSI 才算真正可用于生产，而不是实验室里的一次性成功。运维上也要把 Target 的 saveconfig 与 keytab 当作重要配置备份，避免存储端重建后客户端全掉。

## 速查

```bash
# Target 端
targetcli   # backstores/block create; iscsi create; tpg1/luns create; tpg1/acls create; saveconfig
firewall-cmd --add-service=iscsi-target --permanent
# Initiator 端
vim /etc/iscsi/initiatorname.iscsi
iscsiadm --mode discoverydb --type sendtargets --portal 192.168.1.10:3260 --discover
iscsiadm --mode node --targetname iqn.2026-04.com.lab:server-sdb --portal 192.168.1.10:3260 --login
lsblk /dev/sdb && mkfs.xfs /dev/sdb1 && mount -a
```
