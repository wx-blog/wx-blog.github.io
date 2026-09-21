---
title: LVM 精简池、VDO 去重压缩与 Stratis：三种"省空间"方案怎么选
description: 对比 LVM 精简池、VDO 去重压缩、Stratis 存储池三种节省空间的方案：各自解决什么问题、怎么创建、怎么自动扩容与持久挂载，以及精简卷写满、VDO 统计延迟等踩坑。
pubDate: 2026-09-21
tags: [Linux, 存储, RHCSA]
---

传统分区是「分多少用多少」，预先把空间钉死。但很多时候你给的 50G 里实际只写了 1G，剩下 49G 白白闲置。这篇讲三种把空间「按需分配」的方案：LVM 精简池（Thin Pool）、VDO（去重+压缩）、Stratis（把前者打包成存储池）。它们解决的问题不同，别混为一谈。

## 先分清三者的定位

| 方案 | 核心能力 | 典型场景 |
|---|---|---|
| LVM 精简池 | 超额分配（over-provisioning），卷可以「虚大」 | 虚拟机镜像、多租户按需分配 |
| VDO | 块级去重 + 压缩，相同/可压数据只存一份 | 备份、虚拟机模板、重复文件多的存储 |
| Stratis | 在 LVM/VDO 之上提供「存储池」管理抽象 | 想用一条命令管存储、不想记 LVM 细节 |

简单说：精简池管「分配」，VDO 管「重复数据」，Stratis 管「易用性」。

## LVM 精简池与精简卷

先建好底层的物理卷和卷组，再把一部分空间划成精简池（thin-pool）：

```bash
pvcreate /dev/nvme0n2
vgcreate vg_thin /dev/nvme0n2
lvcreate --type thin-pool --thinpool thinpool -l 80%VG vg_thin
```

`-l 80%VG` 表示把卷组 80% 的空间用作精简池。然后在这个池里开一个「虚拟 50G，实际从池里按需拿」的精简卷：

```bash
lvcreate --type thin --virtualsize 50G --thinpool thinpool -n thinlv vg_thin
```

:::warn
这一步会报警告：`Sum of all thin volume sizes exceeds the size of thin pool`。这是**正常的**——精简配置本来就允许「承诺出去的总虚拟空间 > 实际物理空间」。但代价是：如果所有卷同时写满真实数据，池会溢出。要么控制虚拟总大小，要么开启下面的自动扩容。
:::

格式化、挂载后，`df` 看到的是虚拟大小 50G，而实际占用由池决定：

```bash
mkfs.xfs /dev/vg_thin/thinlv
mkdir /thinlv_mount
mount /dev/vg_thin/thinlv /thinlv_mount
df -h /thinlv_mount
```

随时看池的真实使用率（数据百分比 + 元数据百分比）：

```bash
lvs -o +data_percent,metadata_percent vg_thin/thinpool
```

## 给精简池开自动扩容

默认情况下池满了不会自己长大。要在使用率达到阈值时自动扩，改 `/etc/lvm/lvm.conf` 的 `activation` 段：

```ini
activation {
    thin_pool_autoextend_threshold = 70
    thin_pool_autoextend_percent = 20
}
```

含义：使用率达到 70% 时触发自动扩展，每次扩当前大小的 20%。改完确认生效：

```bash
lvmconfig --type current activation/thin_pool_autoextend_threshold
lvmconfig --type current activation/thin_pool_autoextend_percent
systemctl start lvm2-lvmpolld
```

`lvm2-lvmpolld` 是 LVM 的轮询守护进程，自动扩容靠它驱动。测试时可以用 `watch` 盯着使用率涨：

```bash
watch -n 5 'lvs -o +data_percent vg_thin/thinpool'
```

:::note
自动扩展扩的是 **thinpool 的物理大小**，**不会**改变文件系统的大小。文件系统在 `mkfs` 时就按虚拟大小（50G）固定了。只有当你的实际需求超过 50G、需要把精简卷本身也扩大时，才要再去手动扩文件系统。
:::

## VDO：去重 + 压缩

VDO 工作在块层，能把「相同内容」和「可压缩内容」合并存储。先把相关包装上，并在 LVM 里建一个 VDO 类型的逻辑卷：

```bash
dnf -y install lvm2 vdo
vgcreate vg-vdo /dev/nvme0n2
lvcreate --type vdo \
         --name vdo-test \
         --size 5G \
         --virtualsize 50G \
         vg-vdo
```

`--size 5G` 是物理大小，`--virtualsize 50G` 是逻辑（承诺）大小，相当于 10:1 的精简比例。格式化时加 `-K` 跳过块丢弃，创建更快：

```bash
mkfs.xfs -K /dev/vg-vdo/vdo-test
mkdir -p /mnt/vdo-test
mount /dev/vg-vdo/vdo-test /mnt/vdo-test
vdostats --human-readable
```

验证去重和压缩（素材实测）：

```bash
# 全零数据：VDO 走特殊路径，不实际存储，Used 不变
dd if=/dev/zero bs=10M count=10 of=/mnt/vdo-test/data/file1.bin
# 随机数据：真实占空间
dd if=/dev/urandom bs=10M count=10 of=/mnt/vdo-test/data/file2.bin
sync
vdostats --human-readable
# 复制同一份随机文件：去重生效，Used 不再增长
cp /mnt/vdo-test/data/file2.bin /mnt/vdo-test/data/file3.bin
sync
# 生成高压缩率文本：压缩生效，Space saving 下降
for i in {1..10}; do base64 /dev/urandom | head -c 10000000 > /mnt/vdo-test/data/compress$i.txt; done
sync
```

查看 VDO 卷是否开启压缩/去重：

```bash
lvs -o+vdo_compression,vdo_compression_state,vdo_deduplication,vdo_index_state vg-vdo
```

## Stratis：把存储当"池"来管

Stratis 是红帽主推的存储管理层，底层还是 LVM/VDO，但对外只暴露「池（pool）」和「文件系统（fs）」两个概念。装好并启动服务：

```bash
dnf install stratisd stratis-cli -y
systemctl enable --now stratisd
```

建池、在池里建文件系统，一行一个：

```bash
stratis pool create data_pool /dev/nvme0n2
stratis pool list
stratis fs create data_pool work_fs
stratis fs list
```

挂载时设备路径在 `/dev/stratis/<池>/<文件系统>`：

```bash
mkdir /mnt/stratis_work
mount /dev/stratis/data_pool/work_fs /mnt/stratis_work
df -h /mnt/stratis_work
```

:::note
`stratis fs list` 里每个文件系统显示的总量是 1 TiB，但池本身只用了不到 1 GiB——这就是精简配置：文件系统「看起来」很大，实际占用跟着写入量走。
:::

## 踩坑

**坑一：精简卷虚拟大小超物理，没开 auto-extend 会写满报错。** 这是最典型的生产事故。要么控制虚拟总和，要么必须配 `thin_pool_autoextend_threshold < 100` 并启动 `lvm2-lvmpolld`。

**坑二：`vdostats` 的统计不是实时的。** 写入后 `Used` 可能不变，要等一会儿或手动 `sync` 才会更新。测试时别一写完就立刻看，会被「没生效」误导。

**坑三：全零数据在 VDO 上几乎不占空间。** 看 `vdostats` 显示 `Space saving% 99%` 别以为是压缩神器——那是因为全零块被直接丢弃了。真正压得动的是随机文本这类高冗余数据。

**坑四：VDO 持久挂载要不要 `vdo.service` 看版本。** 老版本需要：

```bash
/dev/vg-vdo/vdo-test  /mnt/vdo-test  xfs  defaults,x-systemd.requires=vdo.service,_netdev  0 0
```

新版本 VDO 集成进 LVM，没有 `vdo.service`，直接 `defaults` 即可。Stratis 持久挂载则要带 `x-systemd.requires=stratisd.service`，否则开机可能挂载不上。

**坑五：清理环境顺序。** 删 Stratis 要先 `fs destroy` 再 `pool destroy`；删 VDO/精简池要从逻辑卷往上 `vgremove`，中途会反复让你确认 `y/n`，想清楚再回车。

## 速查

```bash
# LVM 精简池
vgcreate vg_thin /dev/nvme0n2
lvcreate --type thin-pool --thinpool thinpool -l 80%VG vg_thin
lvcreate --type thin --virtualsize 50G --thinpool thinpool -n thinlv vg_thin
lvs -o +data_percent,metadata_percent vg_thin/thinpool

# VDO
lvcreate --type vdo --name vdo-test --size 5G --virtualsize 50G vg-vdo
vdostats --human-readable

# Stratis
systemctl enable --now stratisd
stratis pool create data_pool /dev/nvme0n2
stratis fs create data_pool work_fs
mount /dev/stratis/data_pool/work_fs /mnt/stratis_work
```
