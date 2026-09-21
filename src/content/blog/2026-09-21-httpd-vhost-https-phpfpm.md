---
title: Web 服务实战：虚拟主机、HTTPS 证书链与 PHP-FPM 集成
description: 用 httpd 在一台服务器托管多个站点（基于名称或 IP:端口），部署带中间证书的 HTTPS 认证链，并用 PHP-FPM 以 FastCGI 方式运行 PHP，覆盖怎么做加为什么加出错怎么办三层，并给出证书链不完整、PHP 不解析等高频故障的定位思路。
tags: [Linux, httpd, HTTPS]
pubDate: 2026-09-21
---

一台 httpd 服务同时托管多个域名、把站点升级成带可信链的 HTTPS、再让 PHP 真正跑起来——这是企业 Web 服务的三道主干。本文把虚拟主机、证书链、PHP-FPM 三件事串成一条可独立照做的链路。

## 虚拟主机：一台 httpd 托管多个站点

**怎么做**：站点配置都放进 `/etc/httpd/conf.d/` 下的独立文件，按「域名」或「IP:端口」区分。基于名称的虚拟主机最常用，关键是 `ServerName` 与 `DocumentRoot`：

```apache
<VirtualHost server01.lab.com:80>
    ServerName server01.lab.com
    ServerAlias www.server01.lab.com
    DocumentRoot /var/www/server01
    CustomLog /var/log/httpd/server01_access.log combined
</VirtualHost>
```

若要用不同端口（如 `888`）区分站点，先让 httpd 监听该端口，再用 IP:端口匹配：

```apache
Listen 888
<VirtualHost 192.168.1.10:888>
    ServerName server01.lab.com
    DocumentRoot /var/www/server01_888
</VirtualHost>
```

默认的「通配」虚拟主机写成 `<VirtualHost *:80>`，在没有更精确匹配时兜底。想把全站根目录从 `/var/www/html` 改到别处，在主配置改 `DocumentRoot`，并用 `DirectoryIndex` 指定首页文件名（如 `home.html`）。`Alias` 还能把 URL 路径映射到文件系统任意目录：

```apache
Alias /test "/realdir"
<Directory "/realdir">
    Require all granted
</Directory>
```

**为什么**：httpd 收到请求后，先用 `Host` 头里的 `ServerName`/端口找到匹配的 `<VirtualHost>`，再用其中的 `DocumentRoot` 定位文件。基于名称的虚拟主机依赖 HTTP 请求头，所以同一 IP 能区分出多个站点；`Alias` 让内容不必都塞进 `DocumentRoot`，便于挂维护页或子路径应用。匹配顺序：精确 `ServerName` 优先，通配 `*:80` 作兜底。

**出错怎么办**：改完用 `httpd -S` 校验虚拟主机匹配，它会列出所有解析结果，不匹配的落到默认主机。若用了非标准端口（如 888）且开了 SELinux，必须打端口标签，否则 httpd 无法监听：

```bash
semanage port -a -t http_port_t -p tcp 888
```

客户端访问前，在 `/etc/hosts` 把域名指向服务器 IP（如 `192.168.1.10 server01.lab.com`）即可绕过 DNS 做本地解析，别忘了 `firewall-cmd --add-service=http`。

## HTTPS 与中间证书认证链

**怎么做**：生产用「根 CA → 中间证书 → 服务器证书」三级链更规范。先生成根 CA 与中间证书（中间证书限制 `pathlen:0`，不能再签发下级 CA）：

```bash
openssl genrsa -out rootCA.key 4096
openssl req -x509 -new -nodes -key rootCA.key -out rootCA.crt -days 3650 -config root_cert.cnf
openssl genrsa -out intermidiate.key 4096
openssl req -new -key intermidiate.key -out intermidiate.csr
openssl x509 -req -in intermidiate.csr -CA rootCA.crt -CAkey rootCA.key -out intermidiate.crt --extfile intermidiate.cnf
```

再用中间证书签发服务器证书，在 `server.cnf` 用 `subjectAltName` 列出备用域名：

```bash
openssl genrsa -out server.key 4096
openssl req -new -key server.key -out server.csr -config server.cnf
openssl x509 -req -in server.csr -CA intermidiate.crt -CAkey intermidiate.key -CAcreateserial -out server.crt -days 365 -sha256 -extfile server.cnf -extensions req_ext
openssl verify -CAfile rootCA.crt -untrusted intermidiate.crt server.crt
```

把 `server.crt`、`server.key`、`intermidiate.crt` 放进 `/etc/pki/tls/`，虚拟主机里同时指定三者：

```apache
Listen 443
<VirtualHost *:443>
    ServerName www.site1.com
    DocumentRoot /var/www/site1
    SSLEngine on
    SSLCertificateFile /etc/pki/tls/certs/server.crt
    SSLCertificateKeyFile /etc/pki/tls/private/server.key
    SSLCertificateChainFile /etc/pki/tls/certs/intermidiate.crt
</VirtualHost>
```

装好 `mod_ssl`（`dnf -y install mod_ssl`）后 `systemctl restart httpd`。

**为什么**：客户端只内置根 CA 信任，它需要靠「中间证书」把服务器证书一路回溯到受信根。`SSLCertificateChainFile` 就是把中间证书发给客户端补全信任链；缺了它，链不完整，浏览器报「证书不受信任」。自签根 CA 必须手动导入客户端信任库，`curl` 加 `--cacert rootCA.crt`。

**出错怎么办**：想让 80 自动跳 443，在 80 的虚拟主机加重写：

```apache
RewriteEngine on
RewriteCond %{HTTPS} !=on
RewriteRule ^/?(.*) https://%{SERVER_NAME}/$1 [R=301,L]
```

客户端验证时若证书无效，先确认根 CA 已导入、且 `SSLCertificateChainFile` 指向「中间」证书而非服务器证书本身。

## PHP-FPM 集成（FastCGI）

**怎么做**：现代 httpd 默认用 PHP-FPM 而非内嵌 `mod_php`。安装启动：

```bash
dnf -y install php php-fpm
systemctl start php-fpm
systemctl restart httpd
```

`/etc/httpd/conf.d/php.conf` 已把 `.php` 通过 Unix 套接字转发给 FPM：

```apache
<FilesMatch \.(php|phar)$>
    SetHandler "proxy:unix:/run/php-fpm/www.sock|fcgi://localhost"
</FilesMatch>
```

在虚拟主机 `DocumentRoot` 下放 `index.php` 即可验证。若 httpd 与 PHP-FPM 分属不同机器，把 FPM 改监听 IP:端口，并同步 httpd 的转发地址：

```bash
# /etc/php-fpm.d/www.conf
listen = 192.168.1.10:9000
listen.allowed_clients = 192.168.1.10, 127.0.0.1
```

```apache
# /etc/httpd/conf.d/php.conf 中的 SetHandler
SetHandler "proxy:fcgi://192.168.1.10:9000"
```

改完 `firewall-cmd --add-port=9000/tcp --permanent` 放行，再 `systemctl restart php-fpm httpd`。

**为什么**：FastCGI 让 Web 服务器只处理 HTTP，PHP 解释器常驻独立进程池，避免每次请求都启动 PHP 的开销，也更利于前后端分离部署。本地用 Unix 套接字（高效、仅本机）、跨机用 TCP，本质都是 FPM 暴露的「监听点」。

**出错怎么办**：访问 `.php` 返回 404/空白，先确认 `php-fpm` 在跑、且 `SetHandler` 的套接字/地址与实际监听一致。跨机场景 SELinux 常拦 FPM 网络监听，可临时 `setenforce 0` 排查，长期应设对应布尔值/端口标签。

## FPM 进程池调优

**怎么做**：`/etc/php-fpm.d/www.conf` 控制进程数，动态模式关键参数：

```ini
pm = dynamic
pm.max_children = 50
pm.start_servers = 5
pm.min_spare_servers = 5
pm.max_spare_servers = 35
slowlog = /var/log/php-fpm/www-slow.log
php_admin_flag[log_errors] = on
```

**为什么**：`pm=dynamic` 按负载弹性增减子进程；`pm=static` 固定数量、`pm=ondemand` 按需拉起（空闲回收）。`max_children` 是内存上限阀门，设太小拒请求、设太大会撑爆内存；`slowlog` 抓执行慢的脚本，是性能排查入口。

## 分文件配置：conf.d 的好习惯

httpd 的主配置 `/etc/httpd/conf/httpd.conf` 通常不建议大肆改动，而是把每个站点、每个模块的配置拆到 `/etc/httpd/conf.d/` 下的独立文件（如 `vhost.conf`、`php.conf`、`ssl.conf`）。好处是「增删站点=增删文件」，不影响主配置，回滚也简单；`httpd -S` 会把所有包含的虚拟主机汇总打印，便于核对匹配。要注意 conf.d 内文件按字母顺序加载，后加载的片段可能覆盖先前的同名指令，所以不要在两个文件里对同一 `ServerName` 写冲突的 `<VirtualHost>`。模块（如 mod_ssl、php 的 conf）也是以 conf.d 片段形式随包安装，启用或停用模块本质是启用或停用对应片段。养成「主配置不动、站点拆文件」的习惯，能让 Web 服务长期可维护，也方便用配置管理工具（Ansible 等）按文件下发，而非 sed 改主配置导致不可预期的差异。

从排错角度，站点异常时第一动作应是 `httpd -S` 看清「请求到底命中了哪个 VirtualHost」——很多「首页不对」「跳错站」的问题，根源是匹配顺序或 `ServerName` 写错，而非内容本身。把配置可读性与 `httpd -S` 校验当成日常习惯，Web 故障的平均修复时间会明显下降。

## 踩坑

- **`CustomLog` 少一个参数直接报语法错**：写 `CustomLog /var/log/httpd/site1_access.log` 会在 `httpd -S` 报「takes two or three arguments」。必须带格式串（如 `combined`/`common`）。
- **自签根 CA 没导入，HTTPS 不通**：`curl https://...` 报证书未知，不是服务挂了，而是客户端不认根 CA——加 `--cacert rootCA.crt` 或导入系统/浏览器信任库。
- **非标准 HTTPS 端口被 SELinux 拦**：用了 `Listen 8443` 却忘 `semanage port -a -t http_port_t -p tcp 8443`，httpd 起不来。标准 443 已带标签，自定义端口必须手动补。
- **FPM 跨机监听被 SELinux 拦**：改 `listen = IP:9000` 后本地 `curl` 仍失败、日志无明确报错。先 `setenforce 0` 验证是否为策略问题，再按规范放行而非长期关防护。
- **Alias 目录忘了开 Require**：`Alias /test /realdir` 后访问 403，因为 `<Directory "/realdir">` 没配 `Require all granted`。Alias 只映射路径，访问权限还得单独授权。

虚拟主机与本机 Web 排错，强烈建议本地先建 /etc/hosts 映射做端到端验证，再开放防火墙与真实 DNS。很多「线上打不开」其实是 ServerName 与访问域名大小写或拼写不一致，`httpd -S` 里一眼就能看出命中了哪个 vhost。SSL 站点则要养成「`curl --cacert` 自签根」的验证习惯，确认证书链完整、域名在 SAN 内，再让浏览器用户去加例外，避免把证书问题误判成网络问题。PHP 集成排错同样分层：先看 php-fpm 进程在不在、再看 SetHandler 的套接字或地址是否对得上、最后看跨机时的 SELinux 与防火墙。把「先本机 hosts 验证、再逐层 extern」当成固定流程，Web 服务的平均修复时间会明显下降，也少踩很多「以为通了其实没通」的坑。

## 速查

```bash
dnf -y install httpd mod_ssl php php-fpm
httpd -S                      # 校验虚拟主机匹配
semanage port -a -t http_port_t -p tcp 888   # 非标准端口打标签
openssl verify -CAfile rootCA.crt -untrusted intermidiate.crt server.crt
systemctl start php-fpm; systemctl restart httpd
firewall-cmd --add-port=9000/tcp --permanent   # PHP-FPM 跨机
```
