---
title: 邮件服务与 TLS：Postfix 虚拟域映射与 Dovecot 加密收件
description: 用 Postfix 做发信与中转、Dovecot 做 IMAP/POP3 收件，通过 virtual_alias_maps 支持多邮件域，再签发 SAN 证书开启 SMTPS/IMAPS 加密通道，并覆盖自签证书不信任、TLS 协商降级、收件鉴权失败等排错要点。目标是搭建一套从发信到收信全链路加密、可承载多个域名的企业邮件服务。
tags: [Linux, 邮件服务, TLS]
pubDate: 2026-09-21
---

自建邮件服务看似吓人，其实就两块：Postfix 负责「发与中转」（MTA），Dovecot 负责「收」（IMAP/POP3，MDA）。再加一层 TLS，就能让明文的 25/143 升级成加密的 465/993。理清这两者的分工，配置就不乱了。

## 邮件系统怎么拼起来

**怎么做**：邮件域靠 DNS 的 `MX` 记录指路——发件方查 `example.com` 的 MX，找到 `mailserver.example.com` 的 A 记录 IP，再把信投给对端 25 端口。收件客户端则用 IMAP（143/993）或 POP3（110/995）连 Dovecot。要让一台 Postfix 同时服务多个域，用虚拟映射而不是改 `mydomain`。

先在内网 DNS（如 unbound 的 auth-zone）里声明 MX 与 A：

```bash
# /etc/unbound/local.d/example.com.zone
$TTL 3600
@   IN SOA  dnsserver.example.com. admin.example.com. ( 2026040901 3600 300 86400 600 )
@   IN NS   dnsserver.example.com.
@   IN MX   10 mailserver.example.com.
mailserver  IN A 192.168.1.128
```

**为什么**：`MX` 优先级数字越小越优先（10 比 20 优先）；`A` 记录把邮件主机名解析成 IP。发件服务器严格按 MX 投递，没有 MX 就会退而求其次用 A，但规范做法是配 MX。`virtual_alias_maps` 把「邮箱地址 → 系统用户」解耦，支持 `alice@example.com` 与 `cathrine@test.com` 落到不同本地账号。

**出错怎么办**：发信被当成「未知用户」多是因为 DNS 的 MX/A 没指向本机，或 `virtual` 映射没生成库。先 `dig MX example.com` 与 `dig A mailserver.example.com` 确认解析到本机。

## Postfix 虚拟域映射

**怎么做**：在 `main.cf` 末尾声明参与的域与映射文件，注释掉原有单 `mydomain` 避免冲突：

```ini
virtual_alias_domains = example.com, test.com
virtual_alias_maps = lmdb:/etc/postfix/virtual
```

`/etc/postfix/virtual` 写地址到用户的映射，左列完整邮箱、右列本地账号：

```ini
alice@example.com alice
bob@example.com   bob
cathrine@test.com cathrine
```

新增系统用户后编译映射库并重启：

```bash
useradd cathrine; passwd cathrine
postmap lmdb:/etc/postfix/virtual
systemctl restart postfix
```

**为什么**：`virtual_alias_domains` 告诉 Postfix「这些域归我管」，`virtual_alias_maps` 是地址改写规则。`postmap` 把文本映射编译成 lmdb 数据库，Postfix 实际查的是库而非文本——改了文本不 `postmap` 等于没改。多域场景下不必为每个域起独立 Postfix 实例。

**出错怎么办**：发信报「User unknown」，先 `postmap lmdb:/etc/postfix/virtual` 确认库已更新；再查 `virtual_alias_domains` 是否含该域。跨域投不到先查 DNS 的 `MX`/`A` 是否指向本机。

## 启用 TLS 加密通道

**怎么做（证书）**：做一张带 SAN 的证书，让 `mailserver.example.com` 与 `mailserver.test.com` 都覆盖：

```bash
vim san.cnf      # CN=mailserver.example.com, subjectAltName=DNS.1/2
openssl req -new -x509 -days 365 -nodes -newkey rsa:2048 \
  -keyout /etc/ssl/private/mail.key -out /etc/ssl/certs/mail.crt \
  -config san.cnf -extensions v3_req
openssl x509 -in /etc/ssl/certs/mail.crt -text -noout | grep -A1 "Subject Alternative Name"
```

**怎么做（Postfix）**：在 `main.cf` 打开收信 TLS 并指向证书，`may` 表示尝试加密但不强制：

```ini
smtpd_use_tls = yes
smtpd_tls_cert_file = /etc/ssl/certs/mail.crt
smtpd_tls_key_file = /etc/ssl/private/mail.key
smtpd_tls_security_level = may
smtpd_tls_ciphers = high
smtpd_tls_protocols = !SSLv2, !SSLv3, !TLSv1, !TLSv1.1
```

`master.cf` 启用 465 的 SMTPS（wrappermode 直接 TLS）：

```ini
smtps     inet  n  -  n  -  -  smtpd
  -o syslog_name=postfix/smtps
  -o smtpd_tls_wrappermode=yes
  -o smtpd_sasl_auth_enable=yes
```

**怎么做（Dovecot）**：`/etc/dovecot/conf.d/10-ssl.conf` 开启并指证书，`10-master.conf` 确认 `imaps`(993)、`pop3s`(995)、`submissions`(465) 监听器存在；再放行一组端口：

```bash
firewall-cmd --add-port=25/tcp; firewall-cmd --add-port=465/tcp
firewall-cmd --add-port=587/tcp; firewall-cmd --add-port=143/tcp
firewall-cmd --add-port=993/tcp; firewall-cmd --add-port=110/tcp
firewall-cmd --add-port=995/tcp
systemctl restart postfix dovecot
```

**为什么**：`smtpd_tls_wrappermode=yes` 让 465 一连接就 TLS（区别于 587 的 STARTTLS 升级）；`!TLSv1` 等关掉老旧协议，避免降级攻击。`smtpd_tls_security_level = may` 兼容老客户端，若要强制加密改 `encrypt`。证书路径在 Postfix 与 Dovecot 两处都要指，且私钥权限 `600`、属主 root。

**出错怎么办**：Postfix 起不来查 `journalctl -u postfix`，多半是证书路径错或私钥权限太开放（Postfix 会拒绝读 group/other 可读的 key）。Dovecot 起不来查 `10-ssl.conf` 的 `ssl_cert`/`ssl_key` 是否带了 `<` 前缀正确引用。

## 验证加密通道

**怎么做**：用 `openssl s_client` 直接对话，确认握手拿到证书：

```bash
openssl s_client -starttls smtp -connect localhost:25 -crlf -quiet   # EHLO 应见 STARTTLS
openssl s_client -connect localhost:465 -crlf -quiet                # 直接 TLS
openssl s_client -connect localhost:993 -crlf -quiet                # IMAPS，可 a1 LOGIN 用户 密码
```

能看到 `CN=mailserver.example.com` 且 `verify error:num=18:self-signed certificate` 就说明链路通了，只是证书自签未被信任。

**为什么**：`s_client` 是验证 TLS 服务的最快手段——不依赖邮件客户端，直接看证书链与协议协商。看到 `250-STARTTLS` 说明 25 端口支持升级加密；看到 `AUTH PLAIN LOGIN` 说明认证机制可用（配合 TLS 才安全）。

**出错怎么办**：465 握手失败，确认 `master.cf` 的 `smtps` 条目与 `smtpd_tls_wrappermode=yes` 都在；993 连不上确认 Dovecot 的 `ssl=yes` 且 `imaps` 监听器 `port=993`。

## 邮件队列与退信排查思路

Postfix 把待发邮件放进队列（maildrop/incoming/active/deferred 等），`postqueue -p` 或 `mailq` 可看当前队列，`postsuper -d` 删单封、`postqueue -f` 强制重投 deferred 队列。邮件发不出去常停留在 deferred，原因可能是对侧 MX 不可达、对端拒收（灰名单/黑名单/超配额）、或 TLS 协商失败。Dovecot 侧收信问题则多在认证：用户 `a1 LOGIN` 失败先确认系统用户存在、PAM 可用、且 `disable_plaintext_auth` 与 TLS 的配合正确——明文认证必须走加密通道，否则 Dovecot 会拒绝。另一个易错点是「发信被当成垃圾」：缺少合理的 HELO 主机名、MX 与发出 IP 不一致、没做反向解析（PTR），都会让对端压低信任。自建邮件想进收件箱，PTR、SPF、DKIM、DMARC 一套比 TLS 本身更关键——TLS 只解决「传输加密」，而这一套解决「你是谁、你是否授权发这个域的邮件」，缺了它们，信再加密也会被扔进垃圾箱。排错顺序建议：先 `postqueue -p` 看卡在哪类错误，再按 SMTP 阶段（连接/MX/TLS/内容）逐段定位。

最后，邮件系统是个「多组件协作」的典型：Postfix 负责发与中转、Dovecot 负责收、unbound 负责解析 MX，甚至还要数据库存用户。任何一环配置错都会表现为「邮件发不出去」或「收不进来」，所以排错时务必先用 `dig MX`、`telnet` 25/465/993 这些单点工具确认每一层独立可用，再谈联动。把「分层验证」刻进习惯，邮件服务的可用性会高很多。

## 踩坑

- **自签证书客户端连不上**：报 `self-signed certificate` 正常，客户端（如 Thunderbird）需手动「添加安全例外」信任这张根。生产应换公开 CA 或内网 CA 签发。
- **security_level=may 不加密也能通**：`may` 只「尝试」加密，对方不支持就明文。要强制加密把 `smtpd_tls_security_level` 改 `encrypt`，但需确认所有客户端都支持。
- **465 与 587 混淆**：465 是 wrappermode（连上即 TLS），587 是 STARTTLS（先明文再升级）。`master.cf` 里 465 必须配 `smtpd_tls_wrappermode=yes`，否则客户端握手失败。
- **防火墙漏端口**：邮件涉及 25/465/587/143/993/110/995 七个端口，漏一个对应功能就超时；不要只放 25。
- **私钥权限太开**：Postfix 拒绝加载 `group/other` 可读的 key，报权限错误起不来。证书私钥务必 `chmod 600`、属主 root。
- **virtual 改了没 postmap**：新增 `cathrine@test.com` 后忘 `postmap`，发信报未知用户。记住「改 virtual 文本必 postmap」。

邮件服务上线前，建议用 `openssl s_client` 把 25/465/993 三个端口都手测一遍，确认每个端口都能完成 TLS 握手与认证，再交付给邮件客户端。很多「客户端连不上」其实是只开了 25 忘了 993/995，或证书路径在 Postfix 与 Dovecot 两处不一致。发信可达性则要靠真实外发测试：给自己其他邮箱发一封，看是否进收件箱、是否被拦，据此补 PTR、SPF、DKIM。自建邮件的「可用」标准是「能收、能发、且不被当垃圾」，三者缺一不可。另外，邮件日志（Postfix 的 maillog、Dovecot 的 auth 日志）是排错第一现场，建议保留足够时长并配合 `postqueue -p` 观察队列，能在用户投诉前就发现「某域开始 deferred」这类苗头。把端口、证书、队列、日志四条监控线拉起来，邮件系统才真正可运维。

## 速查

```bash
# 多域映射
postmap lmdb:/etc/postfix/virtual; systemctl restart postfix
# TLS 证书
openssl req -new -x509 -days 365 -nodes -newkey rsa:2048 \
  -keyout /etc/ssl/private/mail.key -out /etc/ssl/certs/mail.crt -config san.cnf -extensions v3_req
# 验证
openssl s_client -starttls smtp -connect localhost:25 -crlf -quiet
openssl s_client -connect localhost:993 -crlf -quiet
# 防火墙
firewall-cmd --add-port={25,465,587,143,993,110,995}/tcp
```
