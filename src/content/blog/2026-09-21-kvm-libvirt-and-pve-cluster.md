---
title: 从 libvirt 到 Proxmox VE：KVM 虚拟化与 PVE 三节点集群
description: 前半段用 libvirt 工具链在单机上把 KVM 玩明白——存储池、XML 定义虚拟机、快照与克隆；后半段用 Proxmox VE 把三台节点组成集群并跑起 Ceph。两者底层都是 KVM，区别在管理平面，适合脚本化运维还是 Web 集中管理。
pubDate: 2026-09-21
tags: [虚拟化, KVM, Proxmox]
---

这篇把"单机 KVM 虚拟化"和"生产级 PVE 集群"串起来讲：前半段用 libvirt 工具链在单台 Rocky Linux 10 上把 KVM 玩明白（存储池、XML 定义、快照克隆），后半段用 Proxmox VE（PVE）9.2.2 把三台节点组成高可用集群并跑起 Ceph。两者底层都是 KVM，区别在管理平面——libvirt 适合脚本化运维，PVE 适合 Web 集中管理。

## KVM/libvirt 环境搭建

KVM 是内核虚拟化模块，libvirt 是统一的管理 API，上面再叠 `virsh`、`virt-manager`、`cockpit` 等工具。Rocky Linux 10 上装：

```bash
dnf -y groupinstall 'Virtualization Host'
# 或最小安装：
dnf -y install qemu-kvm libvirt virt-install virt-viewer
```

启动所有 libvirt 守护进程 socket，并校验环境：

```bash
for drv in qemu network nodedev nwfilter secret storage interface; do
  systemctl start virt${drv}d{,-ro,-admin}.socket
done
virt-host-validate     # 部分警告可忽略
```

图形化管理两个入口：`virt-manager`（桌面 GUI）和 `cockpit`（Web 控制台，需 `cockpit-machines` 包）。cockpit 默认监听 9090：

```bash
dnf -y install cockpit cockpit-machines
systemctl is-active cockpit.socket
ss -anptul | grep 9090
```

KVM 默认的 NAT 网桥是 `virbr0`（分配 192.168.122.0/24），装好就能用。

## 存储池与存储卷

libvirt 用"存储池（pool）+ 卷（volume）"管理磁盘。建一个目录型池：

```bash
virsh pool-define-as guest_images_dir dir --target "/guest_images"
virsh pool-build guest_images_dir
virsh pool-start guest_images_dir
virsh pool-autostart guest_images_dir
virsh pool-info guest_images_dir
```

在池里建 qcow2 卷：

```bash
virsh vol-create-as --pool guest_images_dir --name vm-disk1 \
  --capacity 20GB --format qcow2
qemu-img info /guest_images/vm-disk1
```

**后端盘 + 前端盘**是省空间的妙招：前端盘以某镜像为 backing，只记录差异，克隆飞快：

```bash
virsh vol-create-as --pool guest_images_dir --name vm-disk1-front \
  --capacity 30G --format qcow2 \
  --backing-vol vm-disk1 --backing-vol-format qcow2
qemu-img info /guest_images/vm-disk1-front
# backing file: /guest_images/vm-disk1
```

`qemu-img create` 直接建的盘不会自动受 libvirt 管理，需 `virsh pool-refresh` 刷新后 `virsh vol-list` 才看得到。

## 用 XML 定义和管理虚拟机

libvirt 里每台虚拟机就是一段 XML。精简模板关键字段如下（已去掉注释）：

```xml
<domain type='kvm'>
  <name>VMNAME</name>
  <memory unit='KiB'>MEMORY_KIB</memory>
  <currentMemory unit='KiB'>MEMORY_KIB</currentMemory>
  <vcpu placement='static'>VCPUS</vcpu>
  <os>
    <type arch='x86_64' machine='pc-q35-rhel10.0.0'>hvm</type>
    <boot dev='hd'/>
  </os>
  <cpu mode='host-passthrough' check='none' migratable='on'/>
  <devices>
    <emulator>/usr/libexec/qemu-kvm</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='DISK_PATH'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <interface type='network'>
      <source network='NETWORK'/>
      <model type='virtio'/>
    </interface>
    <graphics type='vnc' port='-1' autoport='yes'/>
  </devices>
</domain>
```

逐段说明：`<memory>` 是最大内存、`<currentMemory>` 是开机实际内存；`<vcpu>` 是 vCPU 数；`<cpu mode='host-passthrough'>` 把宿主 CPU 特性透传给虚拟机（性能最好）；`<disk>` 里 `bus='virtio'` 用半虚拟化磁盘、性能远胜 IDE；`<interface model='virtio'>` 同样用 virtio 网卡。

改配置用 `virt-xml` 比手编 XML 安全，它一次只动一个块：

```bash
virt-xml test --edit --memory 4096                 # 改内存到 4G
virt-xml test --add-device --disk /var/lib/libvirt/images/newdisk.qcow2,format=qcow2,size=20 --update
virt-xml test --edit --network bridge=br0,model=virtio   # 换桥接网桥
virsh dumpxml test | grep -i mem                    # 改完确认
```

## 快照、克隆与镜像定制

快照用 `virsh snapshot-create-as`：

```bash
virsh snapshot-create-as test snap1
virsh snapshot-list --tree test
virsh snapshot-revert test snap1
virsh snapshot-delete test snap1
```

克隆用 `virt-clone`，会自动换 UUID 和 MAC：

```bash
virt-clone --original test --auto-clone
```

不想启动虚拟机就改镜像内容，用 `guestfish`（基于 libguestfs 库）或 `guestmount`（基于 FUSE 挂成目录）：

```bash
# guestfish 一次性命令：往镜像写 motd
guestfish -a /var/lib/libvirt/images/test.qcow2 -i write /etc/motd "Welcome"
# 挂载成目录直接操作
guestmount -a /var/lib/libvirt/images/test-clone.qcow2 -i /mnt/vm
echo 123 > /mnt/vm/etc/hostname
guestunmount /mnt/vm
```

## PVE 三节点集群

PVE 把 KVM 和 LXC、Ceph、备份、网络虚拟化全收进一个 Web 平台。三节点部署流程：

1. **装系统**：三台虚拟机各装 PVE 9.2.2（4 核 8G，系统盘 200G，每块 20G 的 sdb/sdc/sdd 留给 Ceph OSD，sde 留本地存储），设好主机名 `pve1/pve2/pve3`。
2. **配网络**：编辑 `/etc/network/interfaces`，管理网用 vmbr0 桥接：

```conf
auto lo
iface lo inet loopback

auto nic0
iface nic0 inet static
    address 192.168.1.101/24
    gateway 192.168.1.1

auto vmbr0
iface vmbr0 inet static
    address 10.0.1.101/24
    bridge-ports nic1
    bridge-stp off
    bridge-fd 0
```

3. **建集群**：在 pve1 的 WebUI（`https://10.0.1.101:8006`）`Datacenter → Cluster → Create Cluster`，集群网络选集群专用网段；pve2/pve3 用 `Join Cluster` 粘贴加入信息，各自选好自己的集群 IP 即可。集群靠 Corosync 通信，至少 3 节点才能可靠仲裁、避免脑裂。

4. **PVE 上跑 Ceph**：`Datacenter → Ceph → Install` 勾三节点；各节点 `Ceph → OSD → Create` 把 sdb/sdc/sdd 做成 OSD（共 9 个）；再建池 `rbd-pool`、`cephfs-metadata`、`cephfs-data`，`Ceph → CephFS → Create` 把后两者组成 cephfs，最后 `Datacenter → Storage → Add` 把 RBD 和 CephFS 挂成 PVE 存储。

5. **本地存储分层**：三节点可分别用目录存储、ZFS、LVM-Thin 三种本地存储——目录最简单、ZFS 支持快照压缩校验、LVM-Thin 精简配置按需分配，按场景选。

6. **虚拟机模板与自动化**：基于 ISO 装好 vm1、装 `qemu-guest-agent` 后转模板；克隆出实例即可。云镜像用 `virt-customize` 预装软件再导入：

```bash
virt-customize -a rockylinux10.qcow2 \
  --install httpd \
  --run-command "systemctl enable httpd" \
  --run-command "echo '<h1>Web</h1>' > /var/www/html/index.html"
```

`cloud-init` 方式则创建 vm2 时在 Cloud-Init 选项卡填用户、密码、IP，实现无人值守部署。

7. **迁移与高可用**：基于共享存储（Ceph RBD）右键 `Migrate` 勾 `Online` 即可零停机迁移；把容器设为 HA 资源后，强制关机所在节点，集群会在其他节点自动拉起。

## 踩坑：libvirt 与 PVE 各一处

**坑一（libvirt）：不是所有设备都支持热插拔。** 笔记里 `virt-xml test --remove-device --disk target=vdb --update` 能热拔 virtio 盘，但换 sata 总线时 `virsh detach-disk ... --current` 直接报 `This type of disk cannot be hot unplugged`。结论：热插拔优先用 `virtio` 总线；不支持热拔的先把虚拟机关机再用 `--config` 改。还有内存/CPU：开机时 `setmaxmem` 改不了最大值、 `setmem` 不能超过已设的 maxmem——要调大先关机提 maxmem。

**坑二（PVE）：OSD 建完集群还是 HEALTH_WARN。** 笔记里 OSD 初始状态 `down`，集群报 `HEALTH_WARN`。原因不是配错，而是 OSD 要时间完成初始化和对等，且必须保证 Ceph Public/Cluster 两张网互通。等几分钟、查网络通常就 `up` 了。另一个预期内的报错：PVE 配置文件里先写了 CephFS 挂载，但 Ceph 还没部署完，开机挂载 CephFS 会失败——等 CephFS 建好自然消失，不用慌。

一句话总结：KVM 的日常靠 libvirt 的"池→卷→XML"三件套和 `virt-xml`/`guestfish` 脚本化；上了规模就换 PVE，三节点 + Corosync + Ceph 共享存储，模板/克隆/cloud-init/在线迁移/HA 一套齐全，运维重心从"怎么建虚拟机"变成"怎么设计故障域和备份"。
