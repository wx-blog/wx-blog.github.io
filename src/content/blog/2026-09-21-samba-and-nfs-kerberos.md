---
title: 企业文件共享：Samba 多用户挂载与 NFS 结合 Kerberos
description: 对比 SMB/CIFS 与 NFS 的适用边界，演示 Samba 多用户挂载 multiuser 加 cifscreds 与 autofs 自动挂载，并用 Kerberos 为 NFS 提供强身份认证，给出共享权限错位、票据过期、上下文标签不符等高频问题的定位方法。
tags: [Linux, NFS, Samba]
pubDate: 2026-09-21
---

文件共享是企业里最常见也最容易踩坑的服务。选 SMB 还是 NFS，本质是「跨平台」与「性能/安全」的取舍；而要让访问既可控又安全，Samba 的多用户挂载和 NFS 的 Kerberos 加固是两条必经之路。

## SMB/CIFS 与 NFS 怎么选

**怎么做**：先明确协议边界——SMB（Server Message Block，Linux 侧常以 CIFS 文件系统挂载）原生支持 Windows 与 Linux 互访，访问前需身份认证；NFS（Network File System）主要面向 Linux，默认靠客户端地址 + 系统文件权限做访问控制，要做强认证得叠加 Kerberos。

| 维度 | SMB/CIFS | NFS |
| :--- | :--- | :--- |
| 跨平台 | Windows / Linux 均可 | 主要 Linux |
| 认证 | 默认需用户名密码 | 地址白名单；强认证需 Kerberos |
| 多用户 | 支持（multiuser） | v4 + Kerberos 支持 |
| 客户端权限 | 服务端 `smb.conf` + 系统权限 | 服务端 `exports` + 系统权限 |

**为什么**：SMB 把「身份」带在挂载请求里，所以同一挂载点不同用户能看到不同权限；NFS 传统上信任客户端声明的 UID，跨不可信网络有风险，因此生产环境推荐 NFSv4 + `sec=krb5p` 用票据代替 IP 信任。

## Samba 共享与多用户挂载

**怎么做（服务端）**：安装后建共享目录并打 SELinux 标签，否则 smbd 读不到内容：

```bash
dnf -y install samba samba-common samba-tools
mkdir /smb-share
semanage fcontext -a -t samba_share_t "/smb-share(/.*)?"
restorecon -Rvv /smb-share/
```

在 `/etc/samba/smb.conf` 末尾加共享段，`valid users` 限制可访问者，`write list` 控制可写者，`hosts allow` 限定客户端网段：

```ini
[samba-share]
        comment = share file via SMB
        path = /smb-share
        valid users = david
        writeable = yes
        write list = david
        hosts allow = 192.168.1.0/24
```

Samba 用自己的账户库，系统用户要先 `smbpasswd -a david` 加入，再用 `testparm` 校验语法，最后 `systemctl enable --now smb.service nmb.service` 并 `firewall-cmd --add-service=samba --permanent`。

**怎么做（客户端多用户）**：客户端装 `cifs-utils`，用 `multiuser,sec=ntlmssp` 挂载，挂载时只用某个身份「开门」，真正读写靠每个用户自己的凭据：

```bash
dnf -y install samba-common samba-client cifs-utils
mkdir /mnt/multi
mount.cifs -v -o multiuser,sec=ntlmssp,username=elle,password=1 //192.168.1.10/multi-share /mnt/multi/
```

普通用户 `a` 访问前用 `cifscreds add --username david 192.168.1.10` 注入自己的 SMB 凭据，此后 `touch` 创建的文件的属主就是 david，权限完全按服务端 `write list` 与系统 ACL 判定。

**为什么**：`multiuser` 让「挂载身份」与「访问身份」分离——挂载用 elle（只读）敲门，具体操作时按 `cifscreds` 注入的 david（可写）票据鉴权。`sec=ntlmssp` 是较新的认证封装，比老 `ntlm` 安全。只读用户（elle）创建文件会失败，可写用户（david/frank）则成功，权限由服务端 `write list` 决定。

**出错怎么办**：`touch` 报「权限不够」先分清两层——是挂载身份无写权（换 `write list` 里的用户），还是文件系统属主不对（服务端 `chown`/`setfacl`）。持久化用 autofs 按需挂载，在 `/etc/auto.master.d/samba.autofs` 写 `/share /etc/auto.samba`，在 `/etc/auto.samba` 写：

```ini
smb1    -fstype=cifs,username=david,password=1  ://192.168.1.10/samba-share
multi   -fstype=cifs,multiuser,sec=ntlmssp,cred=/etc/samba.pass ://192.168.1.10/multi-share
```

`cred=/etc/samba.pass` 放只读凭据文件（`chmod 400`），访问时才触发真正的 per-user 认证。`systemctl enable --now autofs` 后，访问 `/share/smb1` 才真正挂载，idle 超时自动卸载。

## NFS + Kerberos 安全加固

**怎么做（KDC）**：Kerberos 服务器装 `krb5-server krb5-workstation`，改 `/etc/krb5.conf` 设 `default_realm = LAB.COM` 并填 `kdc`/`admin_server`，`/var/kerberos/krb5kdc/kdc.conf` 设 realm，再 `kdb5_util create -s -r LAB.COM` 建库，`systemctl enable --now krb5kdc.service kadmin.service` 放行 `firewall-cmd --add-service=kerberos`。

**怎么做（NFS 服务端）**：用 `kadmin.local` 为 nfs 主体发密钥（`add_principal -randkey nfs/server.lab.com` + `ktadd` 导出 keytab），把 `krb5.conf` 与 keytab 拷到 NFS 主机，`/etc/exports` 用 `sec=krb5p` 强制加密认证：

```bash
/exports/share  192.168.1.0/24(rw,sec=krb5p:sys,root_squash)
```

`systemctl enable --now nfs-server.service rpcbind.service gssproxy.service`，放行 `nfs`、`mountd`、`rpc-bind` 服务。

**怎么做（客户端）**：装同款包，取 `client.keytab`，`systemctl enable --now rpc-gssd`，用机器主体取票据并挂载：

```bash
kinit -k -t /etc/krb5.keytab nfs/client.lab.com
mount.nfs -v -o vers=4.2,sec=krb5p server.lab.com:/share /share/secre_nfs/
```

普通用户 `a` 还需 `kinit a` 拿到用户票据，才能 `ls`/`touch` 共享目录。

**为什么**：Kerberos 主体是「服务名/主机名@REALM」形式（如 `nfs/server.lab.com`），keytab 是服务的「密码文件」。`sec=krb5p` 的 `p` 表示既加密又做完整性校验（privacy），比 `krb5`（仅认证）更强。`gssproxy` 替 nfs 服务用 keytab 获取服务票据，避免把 keytab 暴露给所有进程。`/etc/idmapd.conf` 的 `Domain` 决定 UID 如何在不同主机间映射。

**出错怎么办**：挂载或访问报「权限不够」多半是缺票据——机器层面 `kinit -k` 失败说明 keytab 主体名不匹配；用户层面 `ls` 失败说明没 `kinit a`。`showmount -e server.lab.com` 确认导出列表；`Domain` 不一致会导致 UID 映射成 `nobody`。

## SMB 协议版本与安全（弃用 SMB1）

SMB 历经 v1/v2/v3，其中古老的 SMB1（也叫 CIFS 老协议）因 WannaCry 等勒索病毒利用的漏洞已被广泛弃用。现代客户端默认协商到 SMB3（支持加密与更安全的会话），服务端 smb.conf 可通过把最低协议版本抬到 SMB2 以上，杜绝老协议握手。与之配套的是认证强度：`sec=ntlmssp` 比古老的 `ntlm` 多了会话安全协商，multiuser 挂载正是依赖它在同一条 TCP 连接上按不同用户凭据区分权限，而不是每条操作都重新认证。另一个常被忽略的点是「guest 访问」——若共享没限制 `valid users` 且开了 map to guest，匿名用户可能拿到只读甚至可写权限，生产务必显式列出允许的用户并关闭匿名映射。SMB 的安全配置，本质是「协议版本 + 用户白名单 + 文件系统权限」三道闸一起把：协议挡老漏洞、白名单挡陌生人、文件系统权限定粒度。只配其中一道，都可能留下可被利用的缝隙。排错「为什么某用户能写某用户不能」时，就顺着这三道闸逐层核对。

另外，Samba 的 `testparm` 不只会检查语法，还会把生效的服务定义（包括实际应用的协议版本、共享权限）dump 出来，是确认「配置到底有没有按你想的生效」的最快手段。改完 smb.conf 务必跑一次 `testparm`，再 restart，避免把「我以为生效」当成「真生效」。

## 踩坑

- **SELinux 拦 Samba 共享目录**：目录建好却报权限拒绝，`ll -Z` 看到类型是 `default_t`。必须 `semanage fcontext -a -t samba_share_t` + `restorecon`，光改 `smb.conf` 没用。
- **multiuser 挂载身份错配**：用 `elle`（只读）挂载，却指望 `a` 能写。必须 `a` 自己 `cifscreds add --username david` 注入有写权用户的凭据；`cifscreds` 按键环（keyring）维度生效，且要先 `kinit`/登录拿到会话。
- **NFS `sec=krb5p` 没 kinit 直接挂**：挂载成功但 `ls` 即「权限不够」。这是设计如此——Kerberos 把认证从 IP 换成票据，缺用户票据就没有授权来源。
- **防火墙漏放 mountd/rpc-bind**：NFSv4 不止 2049，注册与挂载服务依赖 `mountd`、`rpc-bind`，漏了 `firewall-cmd --add-service=mountd rpc-bind` 客户端 `showmount` 直接超时。
- **keytab 主体不匹配**：客户端 `kinit -k` 报「无密钥」，是 `/etc/krb5.keytab` 里的主体名与主机名/FQDN 对不上。用 `klist -k /etc/krb5.keytab` 核对主体。

Samba 共享上线后，建议做两次验证：一次用 `smbclient -L` 看共享列表是否出现，一次用真正的 multiuser 挂载看不同用户权限是否如预期。不少「能看见但写不了」的问题，根子在服务端文件系统属主而非 smb.conf——用 `ls -Z` 与 `ls -l` 同时确认 SELinux 标签与 Linux 权限，两道闸都过才真正可写。NFS 侧则把 Kerberos 票据的有效性当作第一怀疑点，`kinit` 成功与否往往一句话定位。无论是 SMB 还是 NFS，记住一条总原则：共享服务只决定「谁被允许连、以什么身份」，真正落地的读写权限始终由底层文件系统决定。服务配置与文件系统权限这两层要一起核对，缺任何一层都会表现为「连上了却做不了想做的事」。把验证做成清单，文件共享的可用性就有保障。

## 速查

```bash
# Samba 服务端
semanage fcontext -a -t samba_share_t "/smb-share(/.*)?"; restorecon -Rvv /smb-share/
smbpasswd -a david; testparm; systemctl enable --now smb.service nmb.service
# Samba 客户端
mount.cifs -o multiuser,sec=ntlmssp,username=elle,password=1 //192.168.1.10/share /mnt/m
cifscreds add --username david 192.168.1.10
# NFS + Kerberos
kdb5_util create -s -r LAB.COM
kadmin.local -q "add_principal -randkey nfs/server.lab.com"
exportfs /etc/exports:  /exports/share 192.168.1.0/24(rw,sec=krb5p:sys,root_squash)
mount.nfs -o vers=4.2,sec=krb5p server.lab.com:/share /share/secre_nfs/
```
