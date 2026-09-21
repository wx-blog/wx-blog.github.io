---
title: Ceph 集群部署与 OSD 全生命周期运维
description: 用 cephadm 在 Rocky Linux 10 上把 Ceph 集群从零拉起来，覆盖 OSD 的添加、删除、替换、热备，以及 WAL/DB/DATA 分离的进阶用法。重点讲清每一步之后集群为什么还是 HEALTH_WARN——这些坑才是生产里真正卡人的地方。
pubDate: 2026-09-21
tags: [Ceph, 分布式存储, 集群]
---

这篇用 cephadm（Squid 19.2.3，跑在 Rocky Linux 10 上）把 Ceph 集群从零拉起来，并覆盖 OSD 的完整生命周期：添加、删除、替换、热备、以及 WAL/DB/DATA 分离的进阶玩法。笔记里最值钱的是"每一步之后为什么集群还是 HEALTH_WARN"——这些坑才是生产里真正卡人的地方。

## 部署前置条件

cephadm 是官方推荐的容器化部署工具，每个守护进程都是一个 podman 容器。Rocky Linux 10 默认源里没有 Ceph T 版，笔记用 Squid 版演示：

```bash
dnf install --assumeyes centos-release-ceph-squid
dnf install --assumeyes cephadm
yum -y install python3-jinja2
cephadm version
```

:::warn
**镜像拉不下来是第一个坑。** `podman pull quay.io/ceph/ceph:v19` 如果超时，是访问 quay.io 不畅，需要给 podman 配镜像加速。在 `/etc/containers/registries.conf` 末尾加上：

```ini
[[registry]]
location = "quay.io"
insecure = false

[[registry.mirror]]
location = "m.daocloud.io/quay.io"
insecure = false
short-name-mode = "enforcing"
```

配完用 `podman pull quay.io/ceph/ceph:v19` 验证能正常下载。三节点集群里每台都要配，别只在引导节点配。
:::

另外两个常被忽略的前置检查（笔记里专门用 `getenforce` 和 `firewall-cmd` 验过）：

```bash
getenforce            # 应为 Enforcing
firewall-cmd --get-default-zone   # 应为 public
```

SELinux 和 firewalld 别有改动，否则守护进程间通信会莫名其妙不通。

为什么是主机层的 SELinux/firewalld 而不是容器里的？因为 cephadm 把每个守护进程跑成 podman 容器，但容器用的是宿主机的网络和内核，SELinux 策略、firewalld 区域都在宿主机生效。MON 之间、OSD 之间、Mgr 与客户端之间要通一大批端口（MON 的 6789/3300、OSD 的 6800~7300 段、Mgr Dashboard 的 8443 等），firewalld 若是默认 `public` 且没放行相关服务，容器里怎么排查都通不了——坑在宿主机。所以前置检查里专门用 `getenforce` 和 `firewall-cmd --get-default-zone` 确认，是在排最底层的雷。

## 单节点引导集群

```bash
cephadm bootstrap --mon-ip 192.168.1.100
```

`--mon-ip` 是 Monitor 的地址，引导成功后输出里会给出 Dashboard 的 URL、admin 用户名和临时密码，并把最小配置写入 `/etc/ceph/ceph.conf`、把管理密钥写入 `/etc/ceph/ceph.client.admin.keyring`。注意输出里的 `fsid`（如 `3023d1cc-...`）是集群唯一标识，每台机器都不同，后面的 `cephadm shell --fsid ...` 命令都要用你自己的值。

引导完看状态，会看到一条 HEALTH_WARN：

```bash
ceph -s
# health: HEALTH_WARN
#         OSD count 0 < osd_pool_default_size 3
```

这是正常的——还没加 OSD。命令行访问集群用 `cephadm shell`（自动带配置和密钥进容器），非交互执行用 `cephadm shell -- ceph -s`。

## 添加 OSD：加完盘为什么还是 WARN

先看哪些盘可用，再批量加：

```bash
ceph orch device ls
# HOST  PATH          TYPE  SIZE  AVAILABLE
# ceph  /dev/nvme0n2  ssd   10G   Yes
# ceph  /dev/nvme0n3  ssd   10G   Yes
# ceph  /dev/nvme0n4  ssd   10G   Yes

ceph orch apply osd --all-available-devices
ceph orch ps | grep osd
```

批量加完 3 块盘后，`ceph -s` 反而可能报新错：`Reduced data availability: 1 pg inactive` 和 `Degraded data redundancy: 1 pg undersized`。

:::warn
**这是单节点部署最核心的坑。** 默认 CRUSH 规则按 `host` 做故障域（failure domain），而 `.mgr` 这个系统池默认要 3 个副本。单台机器上只有一个 host，它只能把 3 个副本都放到同一主机、甚至同一批盘上——副本数凑不够，PG 就一直 `undersized` 不活跃。

解决办法是新建一条按 `osd` 做故障域的规则，再把 `.mgr` 池绑过去：

```bash
ceph osd crush rule create-replicated rule_osd default osd
ceph osd pool set .mgr crush_rule rule_osd
ceph -s
# health: HEALTH_OK
```

`create-replicated` 的语法是 `ceph osd crush rule create-replicated <规则名> <root> <故障域类型> <设备类>`。生产多节点环境不需要这步，因为多主机天然满足 host 级故障域；但单节点测试必做，否则集群永远 WARN。
:::

也可以手动逐盘加（受管状态、可单独管理）：

```bash
ceph orch daemon add osd node1.ceph.com:/dev/nvme0n2
ceph orch daemon add osd node1.ceph.com:/dev/nvme0n3
ceph orch daemon add osd node1.ceph.com:/dev/nvme0n4
```

单节点如果图省事，引导时直接加 `--single-host-defaults`，它会自动把 `osd_crush_chooseleaf_type=0`、副本数设成 2，避免上面的 WARN。

## OSD 删除、替换与"不受管"状态

```bash
ceph orch osd rm 2            # 移除 osd.2（不 --zap 则盘数据不清，不能重用）
ceph orch osd rm 2 --replace --zap   # 替换：清空并标记，新盘会在同主机接管
```

`--replace --zap` 是替换盘的正确姿势：清掉旧盘元数据、并预留"同主机同位置建新 OSD"的意图。替换前可以暂停编排避免自动干扰：

```bash
ceph orch pause
ceph orch device zap node1.ceph.com /dev/nvme0n4 --force   # 手动清空某块盘
ceph orch resume
```

:::warn
**手动 `daemon add osd` 加出来的 OSD 是"不受管（unmanaged）"的。** 笔记里验证过：用 `ceph orch apply osd --all-available-devices` 加的 OSD 受 cephadm 托管，删了会自动重建；用 `ceph orch daemon add osd` 加的不会。后果是——你 `ceph orch osd rm 0 --zap` 删掉一个受管 OSD 后，编排器发现磁盘又能用了，会按原 spec 规则立刻把它加回来。要彻底去掉，得先 `ceph orch rm osd.<service_id> --force` 删掉对应的服务定义，再删 OSD。

还有个坑：`.mgr` 池副本数默认 ≥2，直接 `ceph orch osd rm` 删到只剩 1 个 OSD 会卡住（数据无处迁移）。笔记里是先 `ceph osd pool set .mgr size 1 --yes-i-really-mean-it` 临时降副本，或先额外加两块 OSD 承接迁移。
:::

## 非并置 OSD：WAL/DB/DATA 分离

BlueStore 下 OSD 的数据分三部分：**DATA**（对象数据）、**DB**（BlueStore 元数据）、**WAL**（写前日志）。全闪环境常把 DB/WAL 放到更快的 NVMe，DATA 放容量盘，用规格文件（spec）声明：

```yaml
service_type: osd
service_id: osd_using_paths
placement:
  hosts:
    - node1.ceph.com
data_devices:
  paths:
    - /dev/sda
db_devices:
  paths:
    - /dev/nvme0n2
wal_devices:
  paths:
    - /dev/nvme0n3
```

应用与预览（先 `--dry-run` 看分配对不对，再正式应用）：

```bash
ceph orch apply -i osd_spec.yaml --dry-run
ceph orch apply -i osd_spec.yaml
```

:::warn
**spec 里 DB 和 WAL 用相同过滤条件会抢同一批盘。** 笔记踩过这个雷：`data_devices`、`wal_devices`、`db_devices` 都用 `rotational: 0, size: '10G:'`，三者都匹配到同一组 NVMe，结果分配顺序是 data 先拿、wal 再拿、db 最后无盘可用，DB 没分离成功。

两种修法：一是**只写 `db_devices` 不写 `wal_devices`**（WAL 共用 DB 盘，大多数场景够用）；二是给 DB/WAL 用不同 size 过滤条件匹配不同盘。验证分离是否生效：

```bash
ceph osd metadata 2 | grep -E "bluefs_db_devices|bluestore_bdev_devices|devices"
```
:::

## 三节点集群部署要点

三节点用模版机克隆，关键三步：

1. **SSH 互信 + 主机名解析**：引导节点生成密钥，`ssh-copy-id` 到其余节点，并统一 `/etc/hosts`（如 `192.168.1.101 node1.ceph.com`）。
2. **引导时指定集群网络**：`cephadm bootstrap --mon-ip 192.168.1.101 --cluster-network 192.168.2.0/24`，区分 public 与 cluster 网段。
3. **加入节点并打标签**：

```bash
ceph orch host add node2.ceph.com 192.168.1.102
ceph orch host add node3.ceph.com 192.168.1.103
ssh-copy-id -f -i /etc/ceph/ceph.pub root@node2.ceph.com
ceph orch host label add node2.ceph.com _admin   # 带 _admin 标签的节点自动获得配置与密钥
```

带 `_admin` 标签的节点会自动复制 `/etc/ceph/ceph.conf` 和 `ceph.client.admin.keyring`，可以直接当管理节点用。多节点时 OSD 用 `host_pattern` 批量编排：

`_admin` 标签是 cephadm 的"配置分发开关"。引导节点天然带它，它把集群配置和 admin 密钥环推到对应主机，让那台机器上的 `ceph` 命令不用每次带 `--fsid/-c/-k` 就能直接管理集群。笔记里只给 node2 打了 `_admin`，于是 node2 上 `ls /etc/ceph` 能看到 `ceph.conf` 和 `ceph.client.admin.keyring`，而没打标签的 node3 只有 `rbdmap`。生产环境通常给两三个节点打 `_admin`，避免单点丢失后无处管理；但别给所有节点都打，密钥环散得太广反而增加泄露面。

```yaml
service_type: osd
service_id: osd_spec_ssd
placement:
  host_pattern: '*.ceph.com'
data_devices:
  rotational: 0
  size: "20G"
```

Mon/Mgr 数量也能编排：`ceph orch apply mon --placement="3 node1.ceph.com node2.ceph.com node3.ceph.com"`。

## 池管理速查

```bash
ceph osd pool create my-pool 32 32 replicated replicated_rule   # 显式指定 PG 数
ceph osd pool get my-pool size          # 默认 3
ceph osd pool set my-pool size 5        # 改副本数
ceph osd pool set my-pool min_size 3    # 最小可用副本
ceph osd pool application enable my-pool rbd   # 绑定应用类型
ceph osd pool rm my-pool my-pool --yes-i-really-really-mean-it
```

删池受保护：需先 `ceph config set mon mon_allow_pool_delete true`（monitor 级和 global 级都要开），否则删不掉。

## 删除整个集群

实验结束要彻底清除：

```bash
ceph mgr module disable cephadm
ceph fsid                       # 记下你的 fsid
cephadm rm-cluster --force --zap-osds --fsid <你的fsid>
rm -rf /etc/ceph/rbdmap
> /root/.ssh/authorized_keys    # 清掉引导时写入的密钥
```

一句话总结：Ceph 部署的坑八成在"加完 OSD 还是 WARN"——先分清是副本数/故障域不匹配，还是 OSD 不受管被自动加回；把 `ceph -s` 的每条告警当线索，别急着格式化重来。
