---
title: Linux 权限模型一次讲透：基本权限 / SUID·SGID·Sticky / umask / ACL
description: 系统讲透 Linux 文件权限：UGO 基础权限、SUID/SGID/Sticky 特殊权限、umask 默认掩码与 ACL 细粒度授权，读完能独立配置权限并排查"没权限"问题。
pubDate: 2026-09-21
tags: [Linux, 权限, RHCSA]
---

Linux 的权限模型是日常管理里绕不开的基础。它看起来就九个字母（rwxrwxrwx），但真要配对一个共享目录、算准一个 umask、或者看懂 /tmp 后面那个 t，里面门道不少。这篇把 UGO 基础权限、三种特殊权限、umask 和 ACL 串起来讲一遍，力求脱离任何课堂语境也能读懂。

## 基础权限：UGO 与 chmod/chown

每个文件和目录对三类主体分别设权限：所有者（U，User）、所属组（G，Group）、其他人（O，Other）。对文件，r 是读内容、w 是改内容、x 是执行；对目录，r 是列目录、w 是增删文件、x 是进入目录（cd）。没有 x 的目录，连 ls 都列不全。

```bash
ls -l /usr/bin/passwd
# -rwxr-xr-x. 1 root root 33544 Dec 13 2019 /usr/bin/passwd
```

最左一位是类型（- 普通文件、d 目录、l 链接），接着 9 位就是 UGO 三段。改权限有两种写法：

```bash
chmod u+x file            # 符号法：给所有者加执行
chmod go-w file           # 移除组和其他人的写
chmod u=rwx,g=rx,o=r file # 精确设定
chmod 755 file            # 数值法：rwxr-xr-x
chmod -R 750 directory   # 递归修改目录
```

改所有者用 chown，改组用 chgrp，注意冒号写法：

```bash
chown user:group file     # 同时改所有者和组
chown :group file         # 只改组（冒号不能省）
chown -R user:group dir   # 递归
```

:::note
`chmod u+X directory`（大写 X）只对目录加执行、对已有 x 的文件保留——这是递归授权共享目录时最安全的写法，避免把普通文件变成可执行。
:::

## 三种特殊权限

在 rwx 之上还有 SUID、SGID、Sticky，用第 4 位数字或符号表示：

| 权限 | 数字 | 作用对象 | 效果 |
|---|---|---|---|
| SUID | 4 | 可执行文件 | 执行者临时获得文件所有者身份 |
| SGID | 2 | 文件/目录 | 文件：以所属组身份执行；目录：新文件继承目录的组 |
| Sticky | 1 | 目录 | 只有文件所有者或 root 能删除该文件 |

经典例子是 `passwd`：普通用户要写 `/etc/shadow`，靠的就是 SUID。

```bash
chmod u+s file     # SUID
chmod g+s dir      # SGID
chmod o+t dir      # Sticky
chmod 4755 file    # SUID + 755
chmod 1777 dir     # Sticky + 777，对应 /tmp
```

SGID 在协作目录里最实用：把目录设 SGID 后，目录下新建的文件自动归该组，组内成员就能互相读写，不用每次改组。

## umask：新文件的默认权限从哪来

umask 是"创建文件时屏蔽掉的权限"。目录的最大权限是 777，文件是 666（默认不给执行位），实际权限 = 最大权限 - umask，按位减：

```bash
umask            # 查看，root 通常是 022
umask 027        # 临时设置
umask -S         # 符号形式显示
```

常见结果：root（umask 022）建的文件是 644、目录是 755；普通用户（umask 002）则是 664、775。想让新建文件默认更严格，把 umask 写进 `~/.bashrc` 或 `/etc/profile` 即可。

## ACL：给单个用户单独授权

UGO 不够细——比如想让 natasha 能读写、harry 完全不能、其他人都只读，普通权限做不到。ACL（访问控制列表）解决的就是这个：

```bash
setfacl -m u:natasha:rw /var/tmp/fstab   # 给用户加权限
setfacl -m g:developers:rx /project/     # 给组加权限
setfacl -x u:natasha /var/tmp/fstab      # 删除某条 ACL
setfacl -b /var/tmp/fstab                # 清空所有 ACL
getfacl /var/tmp/fstab                   # 查看
```

`ls -l` 看到权限位后面带 `+` 号，就说明这个文件有 ACL。`getfacl` 里有个 `mask` 行，是"有效权限上限"，它会和用户的实际权限做与运算——设了 ACL 后发现不生效，多半是 mask 把权限卡掉了。

## 踩坑：这几个地方最容易错

**坑一：root 不受权限约束。** 把目录 `chmod 000` 后，普通用户进不去，但 root 照样能 `cd` 和 `ls`。排查"为什么某用户读不了"时，先确认你到底是不是在用 root 测试。

**坑二：大写 S/T 表示特殊权限没生效。** `-rwSr--r--` 里的 S（不是 s）说明文件没有 x 位，SUID 实际不起作用。特殊权限必须叠加在 x 之上，否则白设。

**坑三：属主匹配即停止。** 如果当前用户恰好是文件所有者，系统只看 owner 那段权限，后面的 group、other 一律不看。曾有人给文件设了 `chmod u=-` 以为"谁都写不了"，结果属主自己被挡、组内却还能写——因为判定顺序是 owner → group → other，命中第一段就停。

**坑四：SGID 目录里新文件的组。** 不设 SGID 时，alice 建的文件属于 alice 的主组；设了 SGID 才继承目录的组。共享目录协作前先确认这一点，否则权限"看起来对"却写不进去。

## 速查

```bash
# 基础权限
chmod 755 file   chown u:g file   chgrp g file
# 特殊权限
chmod u+s / g+s / o+t      # 或 4xxx / 2xxx / 1xxx
# 默认权限
umask 027
# ACL
setfacl -m u:user:rw 文件   getfacl 文件
```

权限这东西，记住"UGO 三段 + 特殊权限三件套 + umask 决定默认值 + ACL 打补丁"这一条主线，就能覆盖绝大部分日常场景。
