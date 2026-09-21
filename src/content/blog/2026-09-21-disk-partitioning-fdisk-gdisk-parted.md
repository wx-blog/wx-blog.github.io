---
title: 磁盘分区三件套：fdisk / gdisk / parted 一次讲清
description: 讲清 fdisk、gdisk、parted 三种分区工具的差异与用法：MBR 与 GPT 怎么选、主分区/扩展分区/逻辑分区如何划分、parted 该用 MiB 还是 MB，以及新盘识别与分区对齐的踩坑。
pubDate: 2026-09-21
tags: [Linux, 存储, RHCSA]
---

拿到一块新硬盘，第一步永远是分区（Partitioning），而不是急着格式化。这篇把三个最常用工具——`fdisk`、`gdisk`、`parted`——放在同一张台面上对比，让你知道什么时候该用哪个，以及那些只有亲手踩过才会记住的坑。

## 先认盘：新盘加进去系统看不到怎么办

虚拟机或物理机加了一块新盘，内核不一定马上识别。`lsblk` 和 `lsscsi` 能列出当前识别到的块设备和 SCSI 设备：

```bash
lsblk /dev/sda
lsscsi
```

如果看不到新盘，先触发一次总线扫描。`/sys/class/scsi_host/` 下每个 `host*` 目录里写 `- - -` 会让内核重新扫描该 HBA 上的设备：

```bash
for host in /sys/class/scsi_host/host*; do echo "- - -" > "$host/scan"; done
```

还不够就重扫 PCI 总线，并加载常见虚拟磁盘驱动：

```bash
echo 1 > /sys/bus/pci/rescan
modprobe mptspi mpt3sas vmw_pvscsi
```

:::note
`- - -` 三个字段分别是「通道 / 目标 / LUN」，写 `- - -` 表示「这一项通配，全部重扫」。这是一种在线让内核发现新存储的标准做法，不影响已有磁盘。
:::

## MBR 与 GPT：先决定分区表类型

动手前要先想清楚用哪种分区表（Partition Table），因为它决定了你后面能怎么分：

| 维度 | MBR（msdos） | GPT |
|---|---|---|
| 最大磁盘 | 2 TiB | 18 EiB（实际看系统） |
| 主分区数 | 最多 4 个（或 3 主 + 1 扩展） | 默认 128 个 |
| 分区表位置 | 盘首 512 字节 | 盘首 + 盘尾各一份备份 |
| 典型工具 | `fdisk` | `gdisk` / `parted` |

一句话：盘超过 2 TiB、或想要超过 4 个分区，直接上 GPT。小盘且老 BIOS 环境才考虑 MBR。

## fdisk：MBR 交互分区

`fdisk` 默认操作的是传统的 MBR 表。进入交互界面后，核心动作就几个：`n` 新建、`t` 改类型、`p` 打印、`w` 写入。

```bash
fdisk /dev/sda
# n → p → 回车(默认1) → 回车(默认起始) → +1G   建第一个主分区
# n → p → 回车 → 回车 → +1G                    建第二个主分区
# t → 2 → 8e                                   把第2个分区类型改成 Linux LVM
# p                                            查看
# w                                            写入并退出
```

类型 `8e` 是「Linux LVM」的十六进制代号，将来要做 LVM 时认这个。分区大小用 `+1G` 这种写法最直观，比算扇区号省心。

当主分区用掉 3 个后，第 4 个分区默认会变成**扩展分区（Extended）**；扩展分区本身不存数据，它的空间里再划出**逻辑分区**。逻辑分区编号从 5 开始：

```bash
# 第4个分区默认变扩展分区，占满剩余空间
# n → 默认 e → 回车 → 回车
# n → 默认逻辑分区 5 → 回车 → +1G
```

`p` 打印时会看到 `sda4` 是 `Extended`、`sda5` 是逻辑分区。最后 `w` 写盘，`lsblk` 即可确认：

```bash
lsblk /dev/sda
```

:::note
扩展分区不要求必须是第 4 个分区。只要主分区还没占满 4 个，你随时可以把任意一个分区划成扩展分区；只是历史上大家习惯把扩展放在最后。
:::

## gdisk：GPT 分区

GPT 盘的对应工具是 `gdisk`（有些新系统没有预装，先装包）：

```bash
yum -y install gdisk
gdisk /dev/sda
```

交互逻辑和 `fdisk` 几乎一样，区别在类型码：GPT 下 LVM 的类型是 `8e00`（不是 `8e`）。

```bash
# n → 回车(默认1) → 回车 → +1G → 8e00
# p
# w → Y
```

一个细节：如果你在一块已有 MBR 表的盘上跑 `gdisk`，它会提示「Found invalid GPT and valid MBR; converting MBR to GPT」，问你要不要转。这是个**潜在破坏性**操作，不想转就按 `q` 退出。

想写脚本批量建分区时，`gdisk` 也能非交互，靠管道喂输入：

```bash
echo 'n


+1G


w
Y' | gdisk /dev/sda
```

注意顺序：两个空行分别对应「分区号默认」「起始扇区默认」，再给大小、再两个空行（类型默认、确认），最后 `w` 和 `Y`。

## parted：非交互与对齐

`parted` 的好处是原生支持非交互，而且能直接吃「单位」，适合写进自动化。先建 GPT 表，再划分区：

```bash
parted /dev/sda
(parted) mklabel gpt
(parted) mkpart primary xfs 1024MiB 2048MiB
(parted) print
(parted) q
```

`mkpart primary xfs 1024MiB 2048MiB` 的含义是：建一个主分区、文件系统类型标记 xfs、从 1 GiB 起到 2 GiB 止。

:::warn
**优先用 MiB / GiB，不要用 MB / GB。** 1 GiB = 1024 MiB，而 1 GB = 1000 MB，两者差约 4.9%。`parted` 里 `1024MiB` 和 `1GB` 不是一回事，混用会让分区边界和你预期对不上，还可能没对齐到物理扇区。
:::

`parted` 有个反直觉的地方：**交互模式下退出（`q`）会自动保存**，不像 `fdisk` 要显式 `w`。但改完分区表后，建议让 systemd 重新加载，内核才能正确看到变化：

```bash
systemctl daemon-reload
lsblk /dev/sda
```

`parted` 还支持用百分比划分，但要注意起始和结束不能重叠：

```bash
(parted) mkpart test2 xfs 2048MiB 10%   # 报错：20G 的 10% 是 2G，起止相同
(parted) mkpart test2 xfs 2048MiB 20%   # 正确：从 2G 到 4G
```

## 踩坑

**坑一：逻辑分区从 5 开始，且扩展分区占了编号 4。** 在 MBR 下，`sda1~sda4` 是给主分区和扩展分区预留的槽位，真正能挂载的逻辑分区一律从 `sda5` 起。看到 `sda4` 大小只有 `1K` 别慌，那是扩展分区本身的占位。

**坑二：parted 的 `mkpart` 单位是「起点 终点」，不是「起点 大小」。** 容易写成 `mkpart primary xfs 1G 1G`（想表达 1G 大小），结果起止相同直接报错 `Can't have the end before the start!`。要么给绝对终点，要么用百分比。

**坑三：MBR/GPT 互转和 `dd` 擦表都很危险。** 想彻底清掉 GPT 表可以：

```bash
dd if=/dev/zero of=/dev/sda bs=10M count=5
```

但这会连你盘上的数据一起抹掉。擦完 `gdisk -l` 可能报「invalid main GPT header, but valid backup」，因为它从盘尾备份里找回了表——这正是 GPT 双备份设计的体现，但也提醒你：`dd` 只擦盘首，盘尾那份还在。

**坑四：`gdisk` 打开 MBR 盘会默认想转 GPT。** 如果你只是想看看，务必 `q` 退出，别手滑 `w`。

## 速查

```bash
# 认盘
lsblk /dev/sda
lsscsi
for host in /sys/class/scsi_host/host*; do echo "- - -" > "$host/scan"; done

# MBR 分区（类型 8e = Linux LVM）
fdisk /dev/sda        # n / t 8e / p / w

# GPT 分区（类型 8e00 = Linux LVM）
gdisk /dev/sda        # n / 8e00 / w / Y
echo 'n


+1G


w
Y' | gdisk /dev/sda

# 非交互 GPT（记得用 MiB/GiB）
parted /dev/sda mklabel gpt
parted /dev/sda mkpart primary xfs 1024MiB 2048MiB
systemctl daemon-reload
```
