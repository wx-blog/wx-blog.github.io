---
title: CephFS 架构与客户端挂载：MDS、内核驱动与 FUSE
description: CephFS 是 Ceph 提供的 POSIX 兼容分布式文件系统，多台客户端可以同时挂载同一命名空间。这篇讲清 MDS 管元数据、OSD 管数据的分工，跑通 kernel driver 与 FUSE 两条挂载路线，并覆盖配额与快照这两个日常运维点。
pubDate: 2026-09-21
tags: [Ceph, CephFS, 文件系统]
---

CephFS 是 Ceph 提供的 POSIX 兼容分布式文件系统，和 RBD（块）、RGW（对象）并列为三大接口。它和单机文件系统最大的区别是：多台客户端可以同时挂载同一个命名空间、看到同一份文件，且数据跨 OSD 分布。这篇讲清架构，再跑通 kernel driver 与 FUSE 两种客户端挂载，以及配额、快照这些日常运维点。

## 架构：MDS 管元数据，OSD 管数据

CephFS 由三部分组成：

- **MDS（Metadata Server）**：只管目录树、文件权限、inode 等元数据，不存文件内容。CephFS 的性能瓶颈通常在元数据，所以 MDS 可以横向扩多个。
- **元数据池 + 数据池**：一个 CephFS 至少挂两个 RADOS 池，一个存元数据、一个存文件数据。
- **客户端**：通过 kernel 模块（`ceph.ko`）或用户态 FUSE 连进来，多个客户端共享同一视图。

创建文件系统卷时，两个池是自动建好的：

```bash
ceph fs volume create myfs
# 自动创建：
#   pool cephfs.myfs.meta  (元数据)
#   pool cephfs.myfs.data  (数据)
ceph fs ls
```

部署 MDS（建议 1 active + 至少 1 standby，生产最少 2 个实例）：

```bash
ceph orch apply mds myfs --placement="3"
ceph mds stat
# myfs:1 {0=myfs.w2.xxxx=up:active} 2 up:standby
```

`ceph mds stat` 里 `0=...up:active` 是活跃_rank，`up:standby` 是待命。掉一个 MDS，standby 会自动接管，这就是 MDS 的高可用。

## 客户端挂载：kernel 与 FUSE 两条路

客户端机器要先拿到集群配置和密钥。把引导节点的配置与密钥拷过去（带 `_admin` 标签的节点已经有，普通客户端需要手动发）：

```bash
scp /etc/ceph/ceph.conf client:/etc/ceph/ceph.conf
scp /etc/ceph/ceph.client.admin.keyring client:/etc/ceph/
```

**Kernel 驱动挂载（推荐生产）**——走内核态，性能更好：

```bash
mkdir -p /mnt/cephfs-kernel
mount -t ceph 192.168.1.101:6789,192.168.1.102:6789,192.168.1.103:6789:/ \
  /mnt/cephfs-kernel \
  -o name=admin,secretfile=/etc/ceph/admin.key,fs=myfs
df -h /mnt/cephfs-kernel
```

挂载点 `-o` 里给了**所有 MON 的地址**（逗号分隔），这样任一台 MON 挂了客户端仍能连；`fs=myfs` 指定文件系统名；密钥用 `secretfile=` 指文件，而不是把 `secret=` 明文写在命令行（明文会进历史记录，不安全）。

**FUSE 挂载**——走用户态，功能更全、好调试，但稍慢：

```bash
dnf install -y ceph-fuse
mkdir -p /mnt/cephfs-fuse
ceph-fuse -m 192.168.1.101:6789,192.168.1.102:6789,192.168.1.103:6789 \
  /mnt/cephfs-fuse \
  --client_fs=myfs \
  -n client.admin --keyfile=/etc/ceph/admin.key
```

| 对比 | Kernel Driver | FUSE |
| --- | --- | --- |
| 性能 | 更高（内核态） | 稍低（用户态） |
| 功能 | 基本功能 | 完整功能 |
| 内核要求 | 较新内核 | 无要求 |
| 故障恢复 | 自动重连 | 需手动处理 |
| 调试 | 较难 | 较易 |

笔记里专门验证了**多客户端一致性**：在 kernel 挂载点写 `Hello CephFS`，到同一集群的 FUSE 挂载点 `cat` 能立刻读到——两个客户端看到的是同一份数据。

## 配额：目录级与子卷级

**目录配额**用扩展属性 `setfattr`，容量和文件数都能限：

```bash
dnf install -y attr
mkdir -p /mnt/cephfs-kernel/quota-test
setfattr -n ceph.quota.max_bytes -v 104857600 /mnt/cephfs-kernel/quota-test   # 100MB
setfattr -n ceph.quota.max_files -v 100 /mnt/cephfs-kernel/quota-test          # 100 个文件
getfattr -n ceph.quota.max_bytes /mnt/cephfs-kernel/quota-test
# 超配额写入会直接报错
dd if=/dev/zero of=/mnt/cephfs-kernel/quota-test/bigfile bs=1M count=200
# dd: error writing ...: Disk quota exceeded
```

移除配额：`setfattr -x ceph.quota.max_bytes <path>`。

**子卷配额（生产推荐）**——子卷（subvolume）是 CephFS 的"隔离单元"，带配额更好管理：

```bash
ceph fs subvolume create myfs webapp --size 21474836480   # 20GB
ceph fs subvolume info myfs webapp
ceph fs subvolume resize myfs webapp 53687091200          # 扩到 50GB
ceph fs subvolume resize myfs webapp 10737418240 --no_shrink   # 禁止缩容
ceph fs subvolume resize myfs webapp inf                  # 取消配额
```

多租户隔离用子卷组（subvolumegroup）组织：

```bash
ceph fs subvolumegroup create myfs production
ceph fs subvolume create myfs app1 --group_name=production --size=21474836480
```

## 快照：目录级与子卷级

**目录级快照**基于 COW（写时复制），建快照时不拷数据，只有改了才复制：

```bash
mkdir -p /mnt/cephfs-kernel/snap-test/data
echo 'Original v1' > /mnt/cephfs-kernel/snap-test/data/file1.txt
mkdir /mnt/cephfs-kernel/snap-test/.snap/snapshot-v1    # 建快照就是建 .snap 下的目录
echo 'Modified v1' > /mnt/cephfs-kernel/snap-test/data/file1.txt   # 之后改动不影响快照
cat /mnt/cephfs-kernel/snap-test/.snap/snapshot-v1/data/file1.txt   # 仍是 Original v1
ls /mnt/cephfs-kernel/snap-test/.snap/
rmdir /mnt/cephfs-kernel/snap-test/.snap/snapshot-v1    # 删快照
```

**子卷快照**适合做备份点：

```bash
ceph fs subvolume snapshot create myfs app1 snap-v1 --group_name=production
ceph fs subvolume snapshot ls myfs app1 --group_name=production
ceph fs subvolume snapshot rm myfs app1 snap-v1 --group_name=production
```

## 多 MDS：横向扩元数据性能

默认 1 个活跃 MDS，目录多、元数据压力大时可以加到多个：

```bash
ceph fs set myfs max_mds 2
ceph fs status myfs
# RANK  STATE   MDS
#   0  active  myfs.w2.xxxx
#   1  active  myfs.w3.xxxx
#      STANDBY MDS  myfs.w1.xxxx
```

`ceph fs set myfs max_mds 1` 可降回单 MDS。

## 踩坑：两个容易误解的点

**坑一：配额是"协作式"的，不是 MDS 强制。** 笔记里明确点出：目录配额的检查在客户端进行，不是 MDS 在后端强行拦截。意思是老内核或不配合的客户端可能绕过配额。所以生产上管多租户隔离、限额，**用子卷配额（subvolume quota）而不是目录配额**——子卷由 MDS 管，更可靠。目录配额只适合做软提醒。

**坑二：命令行别用 `secret=` 明文。** 挂载时 `secret=AQxxxx==` 直接写在 `-o` 里，会留进 shell 历史、也会出现在进程参数里。正确做法是用 `secretfile=/etc/ceph/admin.key` 或 `keyfile=`，并把 key 文件 `chmod 600`。笔记里两种方法都演示了，生产跟 `secretfile` 走。

**坑三：kernel 与 FUSE 选错场景。** 追求性能、稳跑生产，用 kernel driver；要做复杂功能验证、排查客户端问题，用 FUSE（功能更全、报错更友好）。别反过来。

一句话总结：CephFS 的骨架是"MDS 管元数据、OSD 管数据、客户端共享视图"，挂载优先 kernel driver 并给全 MON 地址做高可用；配额和快照都很成熟，但多租户隔离要落在子卷上而不是目录上。
