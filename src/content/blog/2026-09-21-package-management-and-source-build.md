---
title: 软件包管理到源码编译：dnf / rpm 与 nginx 编译安装全流程
description: 从 dnf/yum 日常包管理、rpm 依赖边界，到 nginx 源码编译安装与 systemd 接管的完整流程，并讲清只下载不安装、历史回滚、编译缺包、80 端口冲突、SELinux 拦截等踩坑。
pubDate: 2026-09-21
tags: [Linux, 包管理, 编译安装]
---

装软件这件事，90% 的情况用包管理器就够了；剩下 10% 需要源码编译（比如要定制模块、要特定版本）。这篇把「dnf / rpm 怎么用」「什么时候必须编译」「编译完怎么交给 systemd 管」串成一条线。

## dnf 和 yum 是一家

在 RHEL 系（含 Rocky、openEuler）新版本里，`yum` 只是 `dnf-3` 的符号链接，二者等价：

```bash
whereis dnf
whereis yum
ll /usr/bin/yum      # lrwxrwxrwx ... /usr/bin/yum -> dnf-3
```

所以下文混用 `dnf` / `yum` 没有区别，挑顺手的写。

## 用 dnf 管理软件包

最常用的一批操作：

```bash
# 只下载不安装（离线分发、缓存到本地再装都靠它）
yum -y install --downloadonly --destdir /testrpm httpd

# 已安装的包，列表里仓库列会带 @ 前缀
yum list | grep httpd

# 按关键字搜、看详情、查"哪个包提供了某个文件"
yum search httpd
yum info httpd
yum provides "/etc/httpd/conf/httpd.conf"

# 重装（配置文件被删了，reinstall 能补回来）
yum -y reinstall httpd-core

# 卸载
yum remove tree
```

:::note
`yum list` 输出里，`httpd.x86_64 ... @appstream` 的 `@` 表示「本机已装，来自 appstream 仓库」；没有 `@` 的是仓库里可用、但还没装。这是一眼区分装没装的最快办法。
:::

装错或想撤销时，用事务历史回滚，比手动反操作稳：

```bash
dnf history
dnf history undo 13     # 撤销第 13 条事务
```

## rpm 的边界：它不替你解决依赖

`rpm` 是底层打包格式，但直接用它装会撞上经典问题——**不自动解决依赖**：

```bash
rpm -qa httpd-tools            # 查询是否已装
rpm -ivh /testrpm/httpd-*.rpm  # 直接装单个，多半报 Failed dependencies
```

报错会列出缺哪些依赖（如 `httpd-core = ... is needed by ...`）。两个出路：要么把依赖包和主包一起喂给它，要么老老实实用 `dnf`。一起装的例子：

```bash
rpm -ivh /testrpm/*.rpm
```

卸载可以强制忽略依赖（危险，慎用）：

```bash
rpm -e --nodeps httpd
```

`rpm` 还有些排查命令很实用：

```bash
rpm -qc httpd-core     # 列出该包带的配置文件
rpm -ql httpd-core     # 列出该包安装的所有文件
rpm2cpio httpd-*.rpm | cpio -idmv   # 不解包安装，只把内容提取出来看
```

## 源码编译安装 nginx 全流程

当你要的版本仓库没有、或要加自定义模块，就得编译。完整链路是：**下载 → 解压 → 配置（决定功能）→ 编译 → 安装**。

先准备源码和一个专用的低权限用户（不登录、不建家目录）：

```bash
wget https://nginx.org/download/nginx-1.28.2.tar.gz
tar -xf nginx-1.28.2.tar.gz
useradd -M -s /sbin/nologin nginx
```

编译需要工具链和开发头文件，缺什么装什么：

```bash
yum -y install gcc gcc-c++ make pcre2-devel zlib-devel openssl-devel
```

`./configure` 决定装到哪、以谁的身份跑、开哪些模块：

```bash
cd nginx-1.28.2
./configure --user=nginx --group=nginx --prefix=/sourcedir/nginx \
            --with-http_ssl_module --with-http_stub_status_module
```

然后编译、安装：

```bash
make
make install
```

装完后二进制在 `--prefix` 指定的目录里，启动并验证：

```bash
/sourcedir/nginx/sbin/nginx
ss -anptul | grep 80          # 看到 0.0.0.0:80 LISTEN 即成功
curl -s 127.0.0.1/nginxpage.html
/sourcedir/nginx/sbin/nginx -s reload   # 热重载配置
/sourcedir/nginx/sbin/nginx -s stop     # 停止
```

想直接敲 `nginx` 而不带全路径，建个软链接：

```bash
ln -s /sourcedir/nginx/sbin/nginx /usr/sbin/nginx
```

## 让 systemd 接管编译版的 nginx

编译安装的 nginx 默认不在 systemd 管控内。自己写一个单元文件即可（`Type=forking` 因为 nginx 以 master/worker 守护进程方式跑）：

```ini
[Unit]
Description=A high performance web server and a reverse proxy server
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=forking
PIDFile=/sourcedir/nginx/logs/nginx.pid
ExecStartPre=/sourcedir/nginx/sbin/nginx -t -q -g 'daemon on; master_process on;'
ExecStart=/sourcedir/nginx/sbin/nginx -g 'daemon on; master_process on;'
ExecReload=/sourcedir/nginx/sbin/nginx -g 'daemon on; master_process on;' -s reload
ExecStop=/sourcedir/nginx/sbin/nginx -s quit
TimeoutStopSec=5
KillMode=mixed
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

放到 `/etc/systemd/system/nginx.service`，重新加载后就能用 `systemctl` 管理：

```bash
systemctl daemon-reload
chown -R nginx:nginx /sourcedir/
systemctl restart nginx.service
```

## 进阶：把源码打成 RPM 包

如果要在多台机器部署同一个编译产物，用 `rpmbuild` 打成 RPM 最省事：

```bash
yum install -y rpm-build rpmdevtools
rpmdev-setuptree                 # 生成 ~/rpmbuild/{SPECS,SOURCES,...}
# 把源码包放进 ~/rpmbuild/SOURCES/
# 编写 ~/rpmbuild/SPECS/nginx.spec（含 %pre/%build/%install/%files）
rpmbuild -ba nginx.spec
```

`%build` 段里放 `./configure ... && make`，`%install` 段里放 `make install DESTDIR=%{buildroot}`，`%files` 段声明要打包进包的文件。这样编译逻辑就被固化成可复用的包，不用每台机器重来一遍。

## 踩坑

**坑一：`rpm -ivh` 单个包装不上，先怀疑依赖。** 这不是包坏了，是 rpm 故意不自动拉依赖。要么 `dnf install 本地rpm路径`（dnf 会替你解决），要么把依赖包凑齐了一起 `rpm -ivh *.rpm`。

**坑二：httpd 和 nginx 默认都抢 80 端口。** 素材里实测，先起了 nginx 再起 httpd 会 `could not bind to address 0.0.0.0:80`。一台机上要共存，至少改掉其中一个的监听端口。

**坑三：编译完直接跑 `objs/nginx` 会报错找不到配置。** 那是没 `make install`、路径还没就位。编译产物要先 `make install` 落到 `--prefix` 目录，才能正常加载 `conf/nginx.conf`。

**坑四：`./configure` 报缺库就装对应的 `-devel` 包。** 比如提示 PCRE、zlib 相关，就 `yum -y install pcre2-devel zlib-devel`，缺 SSL 就 `openssl-devel`。报错信息里写的就是缺什么。

**坑五：SELinux 开着，nginx.service 可能起不来。** 素材里 `systemctl restart nginx.service` 直接失败，临时 `setenforce 0` 就能起。但生产上别长期关 SELinux——正确做法是给网页目录打正确的文件上下文（`httpd_sys_content_t`），而不是关掉安全模块。

## 速查

```bash
# 包管理
yum -y install --downloadonly --destdir /testrpm httpd   # 只下载
yum provides "/path/to/file"                             # 查归属
dnf history undo <ID>                                    # 撤销事务
rpm -qc <pkg> ; rpm -ql <pkg>                            # 查配置/文件

# 源码编译 nginx
yum -y install gcc gcc-c++ make pcre2-devel zlib-devel openssl-devel
./configure --prefix=/sourcedir/nginx --user=nginx --group=nginx
make && make install
ln -s /sourcedir/nginx/sbin/nginx /usr/sbin/nginx

# 交给 systemd
# 写 /etc/systemd/system/nginx.service（Type=forking）后：
systemctl daemon-reload
systemctl restart nginx.service
```
