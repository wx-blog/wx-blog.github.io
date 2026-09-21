---
title: systemd 服务管理与 SSH 加固实战
description: 讲清 systemd 服务管理（单元、开机自启、target）与 SSH 安全加固（密钥登录、禁用 root 密码、配置文件校验），读完能独立管理系统服务并锁好远程入口。
pubDate: 2026-09-21
tags: [Linux, systemd, SSH]
---

systemd 是现代 RHEL 系发行版的初始化系统（PID 1），取代老的 SysV init，最大特点是并行启动、按需激活和用 cgroup 管进程。SSH 则是服务器远程管理的入口，也是被攻击最频繁的服务。这两件事是运维的基本功：前者让你"管得住服务"，后者让你"进得来又不被攻破"。

## systemd 服务管理

`systemctl` 是统一入口。最常用的一组分两类：运行态和开机态。

```bash
systemctl start  sshd        # 启动
systemctl stop   sshd        # 停止
systemctl restart sshd       # 重启（先停后起）
systemctl reload  sshd       # 重载配置，不中断连接
systemctl status  sshd       # 看详细状态、最近日志、主进程
systemctl enable  sshd       # 开机自启
systemctl disable sshd       # 取消开机自启
systemctl is-active sshd     # 是否在跑
systemctl is-enabled sshd    # 是否开机自启
```

`enable --now` 等于"启用并立刻启动"，`disable --now` 是"禁用并立刻停"。还有两个容易混淆的：`try-restart` 只在服务正在运行时才重启；`mask` 会创建一个指向 `/dev/null` 的软链接，让服务彻底无法启动，比 `disable` 更狠——`disable` 还能手动起，`mask` 起都起不来。

```bash
systemctl mask sshd          # 彻底封死
systemctl unmask sshd        # 解封
```

## 自己写一个服务单元

服务由单元文件定义，目录优先级从高到低是 `/etc/systemd/system/` > `/run/systemd/system/` > `/usr/lib/systemd/system/`。下面把一个脚本封装成服务：

```ini
[Unit]
Description=test service
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/1.sh

[Install]
WantedBy=multi-user.target
```

改完或新增单元文件后，必须 `systemctl daemon-reload` 让 systemd 重新加载，再 `systemctl start testsh.service`。

:::note
`Type` 选错会卡启动。`simple` 适合前台运行的程序；如果是会 fork 到后台的守护进程（如传统 `&` 退出的），要选 `forking` 并配 `PIDFile`。否则 systemd 会等不到主进程而报错。
:::

## 系统目标（target）

target 相当于老的运行级别，用 `isolate` 切换、`set-default` 设默认：

```bash
systemctl get-default                 # 当前默认目标
systemctl set-default multi-user.target
systemctl isolate graphical.target    # 切到图形界面
```

常用对照：`multi-user.target` 是命令行多用户（运行级 3），`graphical.target` 是图形界面（运行级 5），`rescue.target` 是救援模式。

## SSH 加固：先锁住入口

SSH 加固的核心就两条：**禁止 root 直接登录**和**强制密钥认证**。相关配置都在 `/etc/ssh/sshd_config`：

```bash
PermitRootLogin no           # 彻底禁止 root 登录
PasswordAuthentication no    # 关掉密码认证
PubkeyAuthentication yes     # 保留公钥认证
MaxAuthTries 3               # 最多试 3 次，挡暴力破解
AllowUsers admin deploy      # 只允许白名单用户
```

改之前先生成密钥并传上去：

```bash
ssh-keygen -t ed25519                       # 比 RSA 更短更安全
ssh-copy-id admin@192.168.1.10              # 把公钥塞进目标机的 authorized_keys
ssh -i ~/.ssh/id_ed25519 admin@192.168.1.10 # 验证能免密登录
```

改完配置别急着退出当前会话，先开第二个窗口验证新配置能登录，再断开旧的——**配置写错会把自己挡在门外**。

```bash
sshd -t                  # 只检查语法，不重启
systemctl reload sshd    # 校验通过后重载
```

## SCP/SFTP 与端口转发

传文件用 SCP（简单）或 SFTP（交互、可断点续传）：

```bash
scp file.txt admin@192.168.1.10:/path/     # 上传
scp -r dir/   admin@192.168.1.10:/path/    # 上传目录
sftp admin@192.168.1.10                     # 进入交互
```

SSH 还能做端口转发，把流量塞进加密隧道：

```bash
ssh -L 8080:internal.web.com:80 jump@192.168.1.10   # 本地转发：访问本机 8080 即访问内网
ssh -D 1080 jump@192.168.1.10                        # 动态转发：本地 SOCKS5 代理
```

## 踩坑：这几个误区别踩

**坑一：先禁密码再测密钥，顺序反了就锁门。** 正确顺序是：先配好密钥登录并验证成功 → 再改 `PasswordAuthentication no` → 再用新会话验证 → 最后才关掉旧连接。

**坑二：`sshd -t` 比直接 restart 安全。** 直接 restart 一旦配置有误，正在运行的 sshd 可能起不来；先 `sshd -t` 校验语法能提前发现问题。

**坑三：改 SSH 监听端口后要同步防火墙。** 把 `Port` 改成 2222 后，别忘了 `firewall-cmd --add-port=2222/tcp --permanent`，否则连不上还以为是配置问题。

**坑四：mask 过的服务起不来。** 排障时如果 `start` 报 "Unit is masked"，先 `unmask`。

## 速查

```bash
systemctl enable --now sshd        # 启用并启动
systemctl status sshd               # 看状态
sshd -t && systemctl reload sshd    # 校验并重载
ssh-copy-id user@host               # 部署密钥
```

服务"管得住"、入口"锁得死"，这两件事做扎实，服务器的可维护性和安全性就都有了底。
