---
title: Ceph Dashboard 多用户与 RBAC 权限体系
description: Dashboard 默认只有一个 admin 超级用户，共用密码既不安全也不好审计。这篇讲清 RBAC 的三层模型——用户、角色、作用域加权限，并给出创建只读监控用户、块存储管理员等实操命令和上手就会遇到的报错。
pubDate: 2026-09-21
tags: [Ceph, Dashboard, 权限]
---

Ceph Dashboard 默认只有一个 `admin` 超级用户，所有人共用同一套密码既不安全也不好审计。Dashboard 内置了完整的 RBAC（基于角色的访问控制，Role-Based Access Control）：建不同权限的用户、把用户归到角色、角色由"作用域 + 权限"组成。这篇把多用户与 RBAC 的玩法讲透，重点在命令和那些一上手就踩的报错。

## RBAC 的三层模型

理解 Dashboard 的权限，记住三层就够了：

- **用户（User）**：能登录的人，绑定一个或多个角色。
- **角色（Role）**：权限集合，由若干"作用域 + 操作"组成。
- **作用域（Scope）**：权限管哪类资源，如 `osd`、`pool`、`cephfs`、`user`。权限类型只有四种：`read`（只读）、`create`、`update`、`delete`。

一句话：用户持角色，角色持"在某个作用域上能干嘛"。

## 用户管理

密码从文件读（避免明文留在历史），`-i` 后面跟密码文件路径。第三个参数是角色名：

```bash
echo -n "YourStrongPassword!" > /tmp/password.txt
# 只读监控用户
ceph dashboard ac-user-create viewer -i /tmp/password.txt read-only
# 块存储管理员
ceph dashboard ac-user-create blockadmin -i /tmp/password.txt block-manager
# 带额外信息的用户
ceph dashboard ac-user-create admin -i /tmp/password.txt administrator "Admin User" "admin@example.com"
```

日常管理：

```bash
ceph dashboard ac-user-show viewer            # 查看用户信息
ceph dashboard ac-user-set-roles viewer read-only        # 改角色（覆盖）
ceph dashboard ac-user-add-roles viewer block-manager    # 追加角色
ceph dashboard ac-user-del-roles viewer block-manager    # 移除角色
ceph dashboard ac-user-set-password viewer -i /tmp/password.txt   # 改密码
ceph dashboard ac-user-set-info viewer "Viewer User" "viewer@example.com"
ceph dashboard ac-user-enable viewer      # 启用
ceph dashboard ac-user-disable viewer     # 禁用（离职/暂离用）
ceph dashboard ac-user-delete viewer      # 删除
```

:::warn
**密码强度不够会直接被拒。** Dashboard 要求密码至少 8 位、含大小写字母、数字和特殊字符，否则报 `Password is too weak`。别用 `123456` 这类，建用户前先把强密码写进 `/tmp/password.txt`。
:::

## 角色管理

内置角色够大多数场景用，需要更细的权限就自建角色。自建角色 = 建空角色 + 往里塞"作用域:权限"：

```bash
ceph dashboard ac-role-create custom-monitor "Custom monitoring role"
ceph dashboard ac-role-add-scope-perms custom-monitor pool read
ceph dashboard ac-role-add-scope-perms custom-monitor osd read
ceph dashboard ac-role-add-scope-perms custom-monitor grafana read
ceph dashboard ac-role-del-scope-perms custom-monitor pool   # 收回某作用域
ceph dashboard ac-role-show custom-monitor                   # 看角色详情
ceph dashboard ac-role-delete custom-monitor                 # 删角色
```

## 内置角色速查

| 角色 | 权限范围 | 适用 |
| --- | --- | --- |
| administrator | 所有范围完全读写 | 系统管理员 |
| read-only | 除 dashboard-settings/config-opt 外全部只读 | 监控/审计人员 |
| block-manager | rbd-image/rbd-mirroring/iscsi/nvme-of 完全，pool/grafana 只读 | 块存储管理员 |
| rgw-manager | rgw 完全，grafana 只读 | 对象存储管理员 |
| cluster-manager | hosts/osd/monitor/manager/config-opt/log 完全，grafana/prometheus 只读 | 集群运维 |
| pool-manager | pool 完全，grafana 只读 | 存储池管理员 |
| cephfs-manager | cephfs 完全，grafana 只读 | 文件系统管理员 |
| ganesha-manager | nfs-ganesha/cephfs/rgw 完全，grafana 只读 | NFS 服务管理员 |

常用作用域（Scope）：`cephfs`、`config-opt`、`dashboard-settings`、`grafana`、`hosts`、`iscsi`、`log`、`manager`、`monitor`、`nfs-ganesha`、`nvme-of`、`osd`、`pool`、`prometheus`、`rbd-image`、`rbd-mirroring`、`rgw`、`user`。

## 实战场景

**场景 1：监控团队只读账号**

```bash
echo -n "Monitor@2024!" > /tmp/password.txt
ceph dashboard ac-user-create monitoring-team -i /tmp/password.txt read-only
```

**场景 2：存储管理员（块 + 对象）**

```bash
echo -n "BlockAdmin@2024!" > /tmp/password.txt
ceph dashboard ac-user-create block-admin -i /tmp/password.txt block-manager
echo -n "RgwAdmin@2024!" > /tmp/password.txt
ceph dashboard ac-user-create rgw-admin -i /tmp/password.txt rgw-manager
```

**场景 3：只能看 OSD 和 Pool 的受限角色**

```bash
ceph dashboard ac-role-create osd-viewer "OSD and Pool viewer only"
ceph dashboard ac-role-add-scope-perms osd-viewer osd read
ceph dashboard ac-role-add-scope-perms osd-viewer pool read
echo -n "OsdViewer@2024!" > /tmp/password.txt
ceph dashboard ac-user-create osd-viewer -i /tmp/password.txt osd-viewer
```

## 踩坑：命令不存在怎么办

**坑一：`ceph dashboard` 子命令报 command not found。** 不是包没装，是 Dashboard 模块没启用。先确认再开：

```bash
ceph mgr module ls | grep dashboard
ceph mgr module enable dashboard
```

模块在 active manager 上启用后，所有 `ac-user-*` / `ac-role-*` 命令才可用。

**坑二：权限不生效，怀疑命令写错。** 先 `ceph dashboard ac-user-show <username>` 看该用户到底挂了哪些角色，再 `ac-role-show <role>` 看角色里有哪些 scope/perm。绝大多数"不生效"是角色没挂对，不是 Ceph 的 bug。

**坑三：共享 admin 账号。** 笔记的最佳实践第一条就是最小权限原则——别图省事 everyone 用 admin。按职责拆角色（cluster-manager 管运维、pool-manager 管池、read-only 给监控），离职就 `ac-user-disable`，比事后排查误删池省力得多。

## 最佳实践

1. **最小权限**：只给完成工作所需的最小权限，监控人员给 `read-only` 即可。
2. **定期审计**：`ac-user-show` 定期过一遍账号列表和角色绑定。
3. **强密码 + 定期换**：长度、大小写、数字、特殊字符四样齐。
4. **禁用不用账户**：人走立刻 `ac-user-disable`，别等出事再删。
5. **角色分离**：按职责建角色，避免权限过度集中到一个账号。

一句话总结：Dashboard RBAC 就是"用户→角色→作用域:权限"三层，内置 8 个角色覆盖绝大多数场景，要更细就 `ac-role-create` + `ac-role-add-scope-perms` 自定义；记住密码强度、模块要先启用、权限不生效先看用户挂了哪些角色——这三条能省掉大部分排障时间。
