---
title: RAID 各级别取舍与故障演练：从 RAID 0 到 RAID 5 热备重建
description: 以 Rocky Linux 10 加软件 RAID（mdadm）为例，把 RAID 0/1/5/6/10 在容量、冗余、性能上的取舍讲清楚，并完整跑一遍 RAID 5 加热备盘的故障模拟与自动重建——这部分是运维真正用得上的。
pubDate: 2026-09-21
tags: [存储, RAID, 磁盘]
---

RAID（独立磁盘冗余阵列，Redundant Array of Independent Disks）是把多块物理盘组合成一个逻辑单元的技术，目标无非三个：用条带化提升吞吐、用镜像或奇偶校验做冗余、把小盘拼成大盘。这篇以 Rocky Linux 10 + 软件 RAID（mdadm）为例，把各级别的取舍讲清楚，并完整跑一遍 RAID 5 加热备盘的故障模拟与自动重建——这部分是运维真正用得上的。

## 各级别怎么选

软件 RAID 用 `mdadm` 在操作系统层实现，零额外硬件成本，阵列可随意迁移到任意 Linux 主机；硬件 RAID 靠独立控制器，性能与缓存更好但被型号绑定。学习、中小企业、云环境优先用软件 RAID。

| 级别 | 最少盘数 | 容错 | 空间利用率 | 原理 |
| --- | --- | --- | --- | --- |
| RAID 0 | 2 | 无 | 100% | 条带化，数据分块并行写入 |
| RAID 1 | 2 | 坏 1 块 | 50% | 镜像，整盘复制 |
| RAID 5 | 3 | 坏 1 块 | (n-1)/n | 条带 + 分布式奇偶校验 |
| RAID 6 | 4 | 坏 2 块 | (n-2)/n | 双重校验 |
| RAID 10 | 4（偶数） | 每组镜像坏 1 块 | 50% | 先镜像再条带 |

一句话判断：要性能不要安全选 0，要绝对安全选 1，容量和冗余折中选 5，怕同时坏两块选 6，既要性能又要冗余选 10。生产上 RAID 5 的写惩罚（每次写都要算校验）在 HDD 上明显，SSD 时代才相对能接受。

条带大小（chunk size）也直接左右性能。笔记里 `--create` 默认用 512K chunk，条带越大、大文件顺序读写越快，但小文件随机读写会浪费带宽。数据库这类随机小 IO 场景可以把 chunk 调小（64K~128K），视频、备份这类大块顺序 IO 用大 chunk 更合适。RAID 5/6 的写惩罚意味着每次改写都要"读旧数据、读旧校验、写新数据、写新校验"四步，所以随机写密集的负载要谨慎上 5/6——要么上 SSD 把延迟吃掉，要么直接改 RAID 10。另一点常被忽略：RAID 提供的是"盘级冗余"，不是"备份"。阵列坏了能重建，但误删文件、中了勒索软件、机房进水，RAID 一个都救不了，该备份还得备份。

数据在 RAID 5 里的分布可以用文字理解为：条带 1 的三块盘分别放 A1、A2、Parity_A；条带 2 把校验位轮转到不同盘（B2、Parity_B、B1），这样校验不会集中在一块盘上，任意一块盘坏了都能用另外两块算回来。

## 用 mdadm 建阵列

环境里给虚拟机加了多块空盘（笔记用的是 `/dev/nvme0n2`~`/dev/nvme0n7`，每块 5G；不同环境盘名不同，先 `lsblk` 确认再动手）。

```bash
dnf install -y mdadm
# RAID 0：纯条带，无冗余
mdadm --create /dev/md0 --level=0 --raid-devices=2 /dev/nvme0n2 /dev/nvme0n3
# RAID 1：镜像
mdadm --create /dev/md1 --level=1 --raid-devices=2 /dev/nvme0n4 /dev/nvme0n5
# RAID 5 + 1 块热备：3 块组成阵列，1 块待命
mdadm --create /dev/md2 --level=5 --raid-devices=3 --spare-devices=1 \
  /dev/nvme0n2 /dev/nvme0n3 /dev/nvme0n4 /dev/nvme0n5
```

`--level` 是级别，`--raid-devices` 是活跃盘数，`--spare-devices` 是热备盘数。建完用 `cat /proc/mdstat` 或 `mdadm --detail /dev/mdX` 看状态，新阵列会先同步（resync），用 `watch -n 1 cat /proc/mdstat` 盯着进度，等 `[UUU]` 全满再继续。

:::note
如果磁盘之前被别的阵列用过，`--create` 会报元数据冲突。先清超级块再建：
`mdadm --zero-superblock /dev/nvme0n{2,3,4,5}`。这条在复用旧盘时必做。
:::

格式化、挂载和写测试文件：

```bash
mkfs.xfs /dev/md2
mkdir -p /mnt/raid5
mount /dev/md2 /mnt/raid5
echo "RAID5 test" > /mnt/raid5/test.txt
```

## 持久化配置

不写配置，重启后阵列不会自动组装。把当前扫描结果写进配置文件：

```bash
mdadm --detail --scan >> /etc/mdadm.conf
```

也可以手动写一行：`ARRAY /dev/md2 metadata=1.2 name=rocky:2 UUID=xxxxxxx`，其中的 UUID 是你的阵列真实值，每台机器都不同，照抄自己的即可。想重新扫描激活已停的阵列用 `mdadm --assemble --scan`。

为什么这一步不能省？mdadm 的阵列信息（元数据、成员盘 UUID、阵列级别）写在某块成员盘的超级块里，开机时内核要靠 `/etc/mdadm.conf` 里的 `ARRAY` 行把分散的盘重新组装成同一个 `/dev/mdX`。不写这个文件，重启后这些盘只是"各自带元数据的普通盘"，不会自动变阵列，挂载点自然也起不来。用 UUID 而不是设备名（`/dev/nvme0nX`）更稳——设备名在重启、插拔后可能变化，UUID 不会变。把 RAID 当数据盘用时这点尤其重要；只有当你明确要让 RAID 承载根文件系统（装系统时就建好阵列），才需要额外处理 initramfs 让它早期就能组装。

## 故障模拟与热备重建

这是 RAID 5 最有价值的一段。故意把一块盘标记故障，看热备如何自动顶上。

```bash
# 1. 标记 sdb 故障
mdadm /dev/md2 --fail /dev/nvme0n6
# 2. 立刻看状态：故障盘标 (F)，热备 sde 变 active sync，开始重建
cat /proc/mdstat
mdadm --detail /dev/md2
# 3. 重建完成后移除坏盘
mdadm /dev/md2 --remove /dev/nvme0n6
# 4. 换新盘（先清超级块）加入阵列当新热备
mdadm --zero-superblock /dev/nvme0n7
mdadm /dev/md2 --add /dev/nvme0n7
# 5. 验证数据还在
cat /mnt/raid5/test.txt
```

整个过程数据不丢、业务不中断，热备盘在故障瞬间就开始回填数据。回填时 `cat /proc/mdstat` 会显示进度条和 `recovery = xx%`，等回到 `[UUU]` 就安全了。

停止和清理（实验结束时）：

```bash
umount /mnt/raid5
mdadm --stop /dev/md2
mdadm --zero-superblock /dev/nvme0n{2,3,4,5,6,7}
```

## 踩坑：三个最容易出错的点

**坑一：忘了写 mdadm.conf，重启阵列消失。** 只 `mkfs` 挂载不算完事，必须 `--detail --scan` 落到 `/etc/mdadm.conf`，否则下次开机阵列不会自动组装，盘上数据还在但找不到入口。

**坑二：复用旧盘不擦超级块。** 在已经做过阵列的盘上再 `--create`，mdadm 会提示元数据冲突甚至拒绝。凡是"盘之前属于别的阵列"，第一步永远是 `mdadm --zero-superblock`。

**坑三：把元数据 1.2 的阵列当启动盘。** 笔记里建阵列时 mdadm 警告：`metadata at the start` 可能不适合做启动设备，老引导程序（GRUB Legacy）不认设备开头的 MD 元数据，会导致系统起不来。要拿 RAID 1 装系统或放 `/boot`，得确认引导程序支持 md/v1.x，否则用 `--metadata=0.90`。还有一条提示：mdadm 会建议开 write-intent bitmap，位图记录哪些块写过，换盘重建时只同步写过的区域，能大幅加快恢复，生产建议开。

补充一点 bitmap 的价值：笔记里建 RAID 1/5 时 mdadm 会问"enable write-intent bitmap?"，建议一律选 y。它的作用是记录哪些数据块被写过，换盘重建时不要求把整块盘从头到尾回拷，而只同步"写过"的区域。恢复时间从"按盘容量算"变成"按实际写入量算"——一块 10G 盘只写了 1G，重建就只搬 1G。生产环境这个开关基本是必开项，尤其盘越大收益越明显。

## 日常监控速查

| 任务 | 命令 |
| --- | --- |
| 看所有阵列概况 | `cat /proc/mdstat` |
| 看阵列详情 | `mdadm --detail /dev/mdX` |
| 加盘 | `mdadm /dev/mdX --add /dev/sdY` |
| 标记故障 | `mdadm /dev/mdX --fail /dev/sdY` |
| 移除盘 | `mdadm /dev/mdX --remove /dev/sdY` |
| 监控重建进度 | `watch -n 1 cat /proc/mdstat` |

一句话总结：RAID 选级别看"要性能还是要安全"，RAID 5 加热备是性价比之选，但真正决定你半夜能不能睡安稳的，是故障演练有没有跑通过、配置有没有持久化。
