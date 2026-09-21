---
title: DNS 原理与 unbound 实战：解析流程、记录类型与缓存控制
description: 从 hosts 与 resolv.conf 到递归迭代讲清 DNS 查询链路，用 dig 实战各类记录，再以 unbound 部署 local-zone、auth-zone、forward-zone 与缓存管理，并拆解 SERVFAIL、NXDOMAIN、NOERROR 空答等典型故障的成因与定位。目标是让读者能独立搭建一台可对外递归、对内权威的缓存域名服务器，而不必依赖公共解析服务。
tags: [Linux, DNS, 网络服务]
pubDate: 2026-09-21
---

DNS 把「人记得住的域名」翻译成「机器要的 IP」。它分层、分布式、靠缓存扛量。理解了「递归 vs 迭代」和「各类记录」，再配 unbound 这类解析器就得心应手。DNS 本身不加密、不认证（除非 DoH/DoT），所以它是互联网里既基础又脆弱的一环。

## DNS 解析流程

**怎么做**：本机解析顺序先看 `/etc/hosts`，再按 `/etc/nsswitch.conf` 的 `hosts:` 行决定（常见 `files dns`），最后查 `/etc/resolv.conf` 里的 `nameserver`。真正走 DNS 时，你的解析器（recursive resolver）替你向根、顶级域、权威服务器做**迭代**查询，把最终 IP 返回给你。

**为什么**：「递归」是客户端委托解析器全权办差（解析器替你跑完所有级）；「迭代」是解析器一级级问、每级只告诉「下一跳在哪」。分层设计让全球域名不需要一个中心数据库，根只指点 `.com` 在哪，`.com` 再指点 `example.com` 的权威。缓存就在每一级降低重复查询。

**出错怎么办**：`ping` 域名不通但 `ping IP` 通，多半是 `resolv.conf` 的 `nameserver` 配错或 `nsswitch` 把 `dns` 放到了 `files` 后才生效。先 `cat /etc/resolv.conf` 确认有可达的 DNS；`nslookup`/`dig` 直接验证。

## 记录类型与 dig 实战

**怎么做**：常用记录：`A`(IPv4)、`AAAA`(IPv6)、`CNAME`(别名)、`PTR`(反向)、`NS`(权威)、`SOA`(起始授权，含序列号/TTL)、`MX`(邮件)。用 `dig` 直接问：

```bash
dig example.com A
dig example.com AAAA
dig -x 192.168.1.10          # PTR 反向
dig NS example.com
dig MX example.com
dig @8.8.8.8 example.com +trace   # 从根迭代追踪
```

**为什么**：`dig +trace` 能可视化「根→TLD→权威」的迭代过程，是理解 DNS 结构的最佳教具。`CNAME` 让 `www` 指向 `example.com`，改 IP 只动一处；`PTR` 用于反查，邮件服务器常校验它防垃圾；`SOA` 里的序列号是主从同步与缓存失效的关键。

**出错怎么办**：`dig` 返回 `SERVFAIL` 说明权威或转发链断了；`REFUSED` 是被服务器拒绝递归（常见于公网 DNS 不对未知网段做递归）；`NXDOMAIN` 是域名不存在。换 `@server` 直查权威服务器可定位是哪一层的问题。

## unbound 安装与基础配置

**怎么做**：unbound 是主流验证型解析器（recursive + 缓存）。安装后改包含文件，开启监听与访问控制：

```bash
dnf -y install unbound
vim /etc/unbound/conf.d/fedora-defaults.conf
# interface: 0.0.0.0
# access-control: 192.168.1.0/24 allow
unbound-checkconf
systemctl enable --now unbound
```

校验语法再启动，避免配置错导致服务起不来：

```bash
unbound-checkconf
```

**为什么**：`access-control` 限定哪些网段能用本机做递归解析，否则你的解析器会变成开放的「DNS 放大器」被滥用（放大攻击）。`interface` 决定监听地址，`do-ip4`/`do-ip6` 控制协议栈，`do-tcp` 决定是否支持 TCP（大响应或 DNSSEC 需要）。

**出错怎么办**：服务起不来先看 `journalctl -u unbound`，多半是 `unbound-checkconf` 能查出的语法错（缩进、端口冲突）。监听 `0.0.0.0` 需确认没有别的进程占 53。

## local-zone、auth-zone 与 forward-zone

**怎么做**：unbound 支持三类区域，优先级大致是 `local-zone` > `auth-zone` > `forward-zone`：

```bash
# 本地覆盖（直接回答，不走公网）
local-zone: "intranet.lab." static
local-data: "host1.intranet.lab. IN A 192.168.1.10"
# 权威区（本机持有 zonefile）
auth-zone:
    name: "example.com"
    zonefile: "/etc/unbound/local.d/example.com.zone"
# 转发区（把某域转发给上游）
forward-zone:
    name: "."
    forward-addr: 8.8.8.8
```

**为什么**：`local-zone`/`local-data` 适合内网假域名，零延迟且不受公网影响；`auth-zone` 让本机成为某域的权威，配合 zonefile 可托管自有域；`forward-zone` 的 `name: "."` 是默认上游，把未知域名转发给公共 DNS。三者分层让你既能「内网自定义」又能「外网照常解析」。`local-zone` 的 `static`/`redirect`/`transparent` 语义不同：`static` 只读本地、`redirect` 改写、`transparent` 本地没有再向上查。

**出错怎么办**：自定义域名解析不到，先确认用的是 `local-zone` 还是 `auth-zone`——类型语义不同；改完 `unbound-control reload` 而非直接重启进程。`forward-addr` 不可达会导致所有未知域名失败。

## 缓存管理

**怎么做**：unbound 把解析结果缓存起来提速。排错或强更时手动清缓存：

```bash
unbound-control dump_cache        # 看当前缓存
unbound-control flush example.com # 清单个域名
unbound-control flush_zone example.com
```

**为什么**：DNS 记录有 TTL，缓存期内不会重新查。改了 zonefile 但客户端仍拿到旧 IP，通常是缓存未失效——清对应域名缓存即可立即生效，不必等 TTL 超时。

**出错怎么办**：改完 zonefile 不生效，记得两件事：序列号（SOA 里那个数）要 `+1` 让从服/缓存感知变更，且 `unbound-control reload` 重新加载；客户端侧同样可能缓存，必要时 `unbound-control flush`。TTL 设太长（如 86400）会让变更传播极慢，内网可设短些（如 300）。

## 递归解析器的信任边界

运行一台开放递归解析器，意味着你在替全网陌生人做查询，风险有三：一是被利用做放大攻击（小查询换大响应），二是成为污染与劫持的跳板，三是耗尽本机资源。因此 `access-control` 严格限定内网是底线，绝不要把 `0.0.0.0/0` 设为 allow。另一个常被忽视的点是「信任谁的上游」：`forward-zone` 指向的公共 DNS 决定了你看到的答案是否可信，若上游被污染，你的所有解析都受影响。对安全敏感的内网，可开启 DNSSEC 校验，让解析器验证签名链、挡掉伪造回答——unbound 默认就带校验逻辑，只需确保根信任锚（root trust anchor）就绪。缓存虽好，但它也意味着「错误答案会被记住一段时间」，所以变更 DNS 记录后清缓存与缩短 TTL 同样重要。最后，解析器本身也要限制并发与缓存大小，避免被单个域名拖垮整台服务器。还有一个常见误区是把解析器当成「万能缓存」——它只缓存它查过的记录，且严格遵循 TTL；TTL 设得过长（比如一天）会让上游记录变更后你的客户端长时间拿旧答案，内网场景把 TTL 设到几分钟更利于快速变更。

## 踩坑

- **NOERROR 但空 ANSWER**：查询返回成功却没答案，常是 `local-data` 写错名字或记录类型不匹配（问 A 却只配了 AAAA）。核对 `local-data` 的 FQDN 与类型。
- **改 zonefile 没 reload / 序列号没 +1**：权威区改了 IP 客户端还是旧值，忘记 `unbound-control reload`，或 SOA 序列号没递增导致下游不更新。
- **别的机器解析超时**：服务器 `access-control` 没放行对端网段，或对端防火墙挡了 53。先在被拒机器 `dig @服务器IP 域名` 验证，再查 `firewall-cmd --add-service=dns`。
- **forward-addr 不可达**：默认转发给公网 DNS 但本机无外网，所有未知域名 `SERVFAIL`。确认 `forward-addr` 可达，或改用内网上游。
- **开放递归被利用**：`access-control` 写成 `0.0.0.0/0 allow`，服务器沦为放大攻击跳板。严格限定内网段。

运维 DNS 最常犯的错是「只在服务器端改了解析，却忘了客户端 resolv.conf 或 nsswitch 的配合」。记住一条链：应用查名字 → nsswitch 决定先 hosts 还是 dns → resolv.conf 决定问哪个服务器 → 服务器再按 zone 与 forward 回答。任何一环配错，表现都是「ping IP 通、ping 域名不通」。养成先 `dig` 直查服务器、再查客户端配置的分层习惯，DNS 问题大多几分钟定位。另一点是别把解析器当万能缓存——它只缓存查过的记录且严格遵循 TTL，内网变更频繁就把 TTL 设短些，改完主动 `flush`。最后，开放递归务必限定内网、开启 DNSSEC 校验，把解析器变成可信且安全的内部基础设施，而不是全网可用的放大跳板。

## 速查

```bash
dnf -y install unbound; unbound-checkconf; systemctl enable --now unbound
dig example.com A; dig -x 192.168.1.10; dig @8.8.8.8 example.com +trace
unbound-control reload
unbound-control flush example.com
```
