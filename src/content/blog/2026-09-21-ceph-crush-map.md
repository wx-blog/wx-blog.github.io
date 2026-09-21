---
title: CRUSH 算法与 CRUSH Map 管理：把数据放到该去的地方
description: CRUSH 让客户端自己算出数据该放在哪个 OSD，不需要中心服务器，集群扩缩容时只迁移必要数据。这篇讲清 CRUSH Map 的结构，完整跑通导出、反编译、编辑、注入四个步骤，并写自定义规则做跨主机故障域隔离与 SSD/HDD 性能分层。
pubDate: 2026-09-21
tags: [Ceph, CRUSH, 分布式存储]
---

CRUSH（Controlled Replication Under Scalable Hashing）是 Ceph 决定"object → PG → OSD"如何放置的算法。它的厉害之处在于**去中心化**：客户端用固定算法自己算出数据该放哪，不用查中心服务器，因此集群扩缩容时只迁移必要的数据。这篇讲 CRUSH Map 的结构、怎么导出/反编译/编辑/注入，以及怎么写自定义规则做故障域隔离和性能分层。

## CRUSH 在解决什么问题

传统存储用中心元数据服务器记录"哪块数据在哪"，规模一大就成了瓶颈。CRUSH 反过来：它把集群的物理拓扑（机房、机架、主机、磁盘）描述成一张 Map，再用伪随机算法把对象名哈希到具体 OSD。三个特性决定了它好用：

- **确定性**：同样的输入永远算到同样的 OSD，客户端随时能独立定位。
- **稳定性**：加盘或掉盘时，只有受影响的部分 PG 迁移，不会全量重排。
- **拓扑感知**：规则里写"副本必须落在不同主机/机架"，故障域就天然隔离了。

## CRUSH Map 的四类元素

| 元素 | 含义 | 例子 |
| --- | --- | --- |
| Devices | 叶子节点，对应一个 OSD | osd.0 ~ osd.8 |
| Bucket Types | 中间节点的层次类型 | osd, host, rack, datacenter, root |
| Bucket Instances | 具体的中间节点 | host `w1`、rack `rack1`、root `default` |
| Rules | 数据放置策略 | `replicated_rule`、`ssd_rule` |

查看当前结构不需要导出：

桶里的 `weight` 和 `alg` 是两个最容易看不懂、却最影响分布的字段。`weight` 约等于这块（或这堆）存储的容量权重，OSD 一般是"盘容量(GB)/1TB"量级的数值，桶的 weight 是其下所有设备的 weight 之和。CRUSH 按 weight 比例分配 PG——weight 配错，数据会明显倾斜到某些盘，有的盘满、有的盘空。`alg straw2` 是当前默认且推荐的桶算法，它保证"加盘时只有落到新盘的 PG 迁移、其余不动"；老的 straw 算法在扩缩容时会多迁不少数据。一句话：`weight` 决定"放多少"，`straw2` 决定"加减盘时动多少"。

```bash
ceph osd crush tree        # 树形拓扑
ceph osd crush class ls    # 设备分类（hdd/ssd/nvme）
ceph osd crush rule ls     # 规则列表
ceph osd crush rule dump   # 所有规则详情
```

## 导出、反编译、编辑、注入

这是管理 CRUSH Map 的标准四步。反编译需要 `ceph-base` 包提供 `crushtool`。

```bash
# 1. 导出二进制 CRUSH Map
ceph osd getcrushmap -o /tmp/crushmap.bin
# 2. 反编译成文本（可读可改）
crushtool -d /tmp/crushmap.bin -o /tmp/crushmap.txt
# 3. 编辑（vim /tmp/crushmap.txt），改前先备份
cp /tmp/crushmap.txt /tmp/crushmap-backup.txt
# 4. 编译回二进制
crushtool -c /tmp/crushmap.txt -o /tmp/crushmap-new.bin
# 5. 注入集群
ceph osd setcrushmap -i /tmp/crushmap-new.bin
```

:::warn
**注入失败最常见的两类原因。** 一是规则 `id` 重复：新增 `rule` 的 `id` 必须全局唯一，和已有规则撞了 `crushtool -c` 能过，但 `setcrushmap` 注入后集群状态会异常。二是桶（bucket）的 `id` 用了正数或和 OSD 的 id 冲突——OSD 用正数 id，桶必须用负数 id（如 `-13`）。改完先用 `crushtool -c` 编译，编译报错比注入后排查省事得多。
:::

## 自定义规则：跨主机故障域

在文本里 `# rules` 段加一段。下面这条要求 3 个副本落在不同 `host`：

```text
rule custom_host_rule {
    id 1
    type replicated
    min_size 1
    max_size 3
    step take default
    step chooseleaf firstn 0 type host
    step emit
}
```

逐段解释：`id 1` 是规则编号；`type replicated` 表示副本池；`step take default` 从 root `default` 开始选；`step chooseleaf firstn 0 type host` 是核心——`chooseleaf` 一直选到叶子（OSD），`type host` 要求这些 OSD 分属不同主机，`0` 表示"选到满足副本数为止"；`step emit` 输出结果。

更省事的方式是直接用命令生成，效果等价：

```bash
ceph osd crush rule create-replicated custom_host_rule default host
ceph osd crush rule dump custom_host_rule
```

把池绑到这条规则上：

```bash
ceph osd pool create test_custom 32 32 replicated custom_host_rule
ceph osd pool set test_custom crush_rule custom_host_rule
```

## 设备分类规则：SSD/HDD 性能分层

Squid 版能自动识别磁盘类型。可以把热数据放 SSD、冷数据放 HDD，完全靠规则过滤：

```bash
# 基于设备类建规则：仅选 ssd 设备，副本跨 host
ceph osd crush rule create-replicated ssd_rule default host ssd
ceph osd pool create test_ssd 32 32 replicated ssd_rule
```

如果要临时改某块盘的分类（实验里常用），先删再设：

```bash
ceph osd crush rm-device-class osd.1
ceph osd crush set-device-class hdd osd.1
ceph osd tree | grep osd.1    # 确认分类变了
```

`ceph osd tree` 里 `CLASS` 列会显示该 OSD 当前归类，改完立刻生效、无需注入。

## 多层级拓扑：机房 / 机架

生产环境往往要 rack 甚至 datacenter 级故障域。在 `# buckets` 段手工加层级，再在 `# rules` 段引用：

```text
rack rack1 {
    id -13
    alg straw2
    hash 0
    item w1 weight 0.05846
}
rack rack2 {
    id -14
    alg straw2
    hash 0
    item w2 weight 0.05846
}
rack rack3 {
    id -15
    alg straw2
    hash 0
    item w3 weight 0.05846
}
datacenter dc1 {
    id -16
    alg straw2
    hash 0
    item rack1 weight 0.05846
    item rack2 weight 0.05846
}
root default {
    id -1
    alg straw2
    hash 0
    item dc1 weight 0.11692
    item rack3 weight 0.05846
}
```

`alg straw2` 是当前推荐的桶算法（老集群可能用 `straw`），`weight` 是容量权重，约等于盘容量（GB）/1TB 的量级，决定数据倾斜程度。`id` 都是负数、`hash 0` 是固定写法。

配套的规则可以写跨机架、跨数据中心，以及只选某类介质的 SSD/HDD 专用规则：

```text
rule cross_rack {
    id 4
    type replicated
    step take default
    step chooseleaf firstn 0 type rack
    step emit
}
rule ssd_only {
    id 5
    type replicated
    step take default class ssd
    step chooseleaf firstn 0 type host
    step emit
}
```

`step take default class ssd` 里的 `class ssd` 就是设备类过滤，只从 SSD 桶里选。

## 用 crushtool 验证分布，而不是盲信

改完别急着写数据，先用 `--test` 模拟 100 个对象看分布是否均匀、是否跨域：

```bash
ceph osd getcrushmap -o /tmp/crushmap-current.bin
crushtool -i /tmp/crushmap-current.bin --test --show-statistics \
  --rule 4 --num-rep 3 --min-x 1 --max-x 100
```

`--rule 4` 对应上面 `cross_rack` 的 id，`--num-rep 3` 是副本数。输出会给出每个 OSD 被选中的次数分布，理想情况应该是均匀的。

:::warn
**故障域节点数不够会直接 undersized。** 笔记里 `cross_datacenter` 规则要求 3 副本跨数据中心，但 `dc2` 里只有一个 rack、一个 host，凑不出 3 个独立故障域，池就一直是 `active+undersized`。结论很直接：**副本数必须 ≤ 故障域内的节点数**。跨机架规则在 3 机架环境下是 `active+clean` 的，跨数据中心在只有 2 个 dc 且其中一个太小时就不行。
:::

## 清理

测试池和规则用完要收尾，删规则前先确认没有池在用它：

```bash
ceph osd pool delete test_custom test_custom --yes-i-really-really-mean-it
ceph osd pool delete test_ssd test_ssd --yes-i-really-really-mean-it
ceph osd crush rule rm custom_host_rule
ceph osd crush rule rm ssd_rule
```

一句话总结：CRUSH Map 就是 Ceph 的"寻址地图"，`getcrushmap → crushtool -d → 改 → crushtool -c → setcrushmap` 是标准闭环；写规则时记住 `chooseleaf type` 决定故障域、`class` 决定介质分层，改前备份、改后用 `--test` 验证，比事后排障省十倍力气。
