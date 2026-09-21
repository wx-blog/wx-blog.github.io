---
title: RHCSA 备考：LVM 命令速查与三个容易踩的坑
description: LVM 是 RHCSA 考试的必考项，命令不多但组合起来容易乱。这里按「建→扩→缩→迁→删」理一遍，并记下三个我反复出错的地方。
pubDate: 2026-09-15
tags: [Linux, RHCSA, 存储]
---

RHCSA 里 LVM 出现的频率极高，而且它不只是考命令，还考你对层级关系的理解。这篇按操作流程整理一遍。

## 层级关系先理清

```
Physical Volume (PV)  ← 物理卷，来自分区或整盘
        ↓
Volume Group (VG)     ← 卷组，PV 的池子
        ↓
Logical Volume (LV)   ← 逻辑卷，真正格式化和挂载的东西
```

记一句话就够：**PV 是砖，VG 是桶，LV 是舀出来的水。**

:::note
考试环境里 `/dev/sdb` 通常是给你操作的那块空盘。动手前先跑 `lsblk` 确认，
别把系统盘上的分区给改了。
:::

## 建

```bash
# 1. 划分区（类型改成 8e，Linux LVM）
fdisk /dev/sdb          # n → p → +2G → t → 8e → w
partprobe /dev/sdb

# 2. 建 PV
pvcreate /dev/sdb1
pvs                     # 确认

# 3. 建 VG
vgcreate vgdata /dev/sdb1
vgs

# 4. 建 LV（-l 按 extent，-L 按容量）
lvcreate -L 1G -n lvweb vgdata
lvs

# 5. 格式化 + 挂载
mkfs.xfs /dev/vgdata/lvweb
mkdir -p /var/www/html
echo "/dev/vgdata/lvweb /var/www/html xfs defaults 0 0" >> /etc/fstab
mount -a
```

:::warn
`mkfs` 会**清空**目标设备上的所有数据，而且没有二次确认。
敲命令前务必回头看一眼设备名是不是你要的那一个。
:::

## 扩

扩容比缩容安全得多，**考场上优先用扩**。

```bash
# PV 层先加砖
pvcreate /dev/sdc1
vgextend vgdata /dev/sdc1

# LV 扩 500M
lvextend -L +500M /dev/vgdata/lvweb

# 文件系统跟上
xfs_growfs /var/www/html      # XFS
resize2fs /dev/vgdata/lvweb   # ext4
```

一步到位的写法（推荐，考场省时间）：

```bash
lvextend -r -L +500M /dev/vgdata/lvweb
```

`-r` 会自动调文件系统，XFS 和 ext4 都认。

## 缩

**XFS 不支持缩小**，只能扩。ext4 可以，但必须按顺序来：

```bash
umount /data                          # 1. 先卸载
e2fsck -f /dev/vgdata/lvdata          # 2. 强制检查
resize2fs /dev/vgdata/lvdata 800M     # 3. 先缩文件系统
lvreduce -L 800M /dev/vgdata/lvdata   # 4. 再缩 LV
mount -a                              # 5. 挂回来
```

顺序反了就是数据丢失。考试里如果题目没明说缩容，别自己找麻烦。

## 三个我反复踩的坑

**坑一：扩完不扩文件系统。** `lvs` 显示容量变了，但 `df -h` 没变——因为文件系统还是老的。这是最常见的失分点，看到 `df` 和 `lvs` 对不上，先想这一步。

**坑二：`/etc/fstab` 写了但没测。** 写完一定要 `mount -a` 验证，再 `findmnt --verify`。fstab 写错会导致系统起不来，考场重装环境极其浪费时间。用 UUID 比用设备名稳，`blkid` 取一下。

**坑三：swap 也用 LV，但忘了改优先级。** 多块 swap 用 LV 建的时候，`/etc/fstab` 里要带 `pri=` 参数，否则开机顺序不确定。

## 一条命令自检

不确定状态时，按层级挨个看：

```bash
pvs && vgs && lvs && df -hT | grep -v tmpfs
```

四行输出对齐着看，PV 有没有空闲、VG 剩多少、LV 和文件系统是否一致，一目了然。
