---
title: Docker 基础：从安装、容器生命周期到用 Dockerfile 自制镜像
description: 一篇跑通 Docker 单机核心用法：环境准备与镜像加速、容器的创建/启动/停止/删除与重启策略、镜像的拉取/打标签/删除，以及用 Dockerfile 制作镜像（含多阶段构建）并推送到私有仓库。读完能独立在 Linux 上部署第一个容器化应用。
pubDate: 2026-09-21
tags: [Docker, 容器]
---

Docker 把"应用 + 运行环境"打包成一个可移植的镜像（Image），镜像跑起来就是容器（Container）。这篇把单机上最常用的动作串一遍：先把引擎装好、能拉镜像，再搞清楚容器从生到死的过程，最后学会用 Dockerfile 把你自己写的程序做成镜像。命令全部在 Rocky Linux / RHEL 系上验证过，复制到同环境即可复现。

## 安装前：环境检查与冲突包

在 RHEL 系发行版上，系统可能自带 podman 这类容器运行时，它和 Docker 的运行时会抢资源。装之前先确认两件事：防火墙状态、有没有冲突包。

```bash
# 防火墙状态：安装前到容器运行后要保持一致（要么一直 active，要么一直 inactive）
systemctl is-enabled firewalld.service
systemctl is-active firewalld.service

# 检查是否有冲突的容器运行时 / 旧 runc
rpm -qa | grep podman
rpm -qa | grep runc
```

```bash
# 移除 podman，避免和 docker 的运行时冲突
dnf -y remove podman
```

为什么先查冲突包？Docker 依赖 containerd 和 runc 作为底层运行时，而 podman 也用 runc，两者同时装容易让 `dockerd` 启动异常或命令行为不一致。确认干净后再装：

```bash
dnf -y install dnf-plugins-core
dnf config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
systemctl is-active docker
```

`enable --now` 一次完成"开机自启 + 立即启动"，比分开写 `systemctl enable` 和 `systemctl start` 省一步。装完后用 `systemctl is-active docker` 确认是 `active` 再往下走。

## 镜像加速：让 docker run 不再卡在拉取

刚装好的 Docker 默认连 `docker.io`。如果在国内网络直接 `docker run hello-world`，大概率会卡在拉取阶段，报 `connection refused` 或长时间无响应。

```bash
docker run hello-world
# 典型报错：failed to resolve reference "docker.io/library/hello-world:latest"
```

解决方法是给引擎配置镜像加速站（mirror），从此拉取请求走加速站而非直连官方源。配置写在 `/etc/docker/daemon.json`：

```json
{
  "registry-mirrors": [
    "https://docker.1ms.run",
    "https://docker.m.daocloud.io"
  ]
}
```

改完必须重启引擎才能生效：

```bash
systemctl restart docker
docker run hello-world
```

:::note
`daemon.json` 是 Docker 引擎的全局配置，改错一个逗号都会导致 `dockerd` 起不来。每次改完用 `systemctl restart docker` 之后，务必 `docker version` 或 `docker info` 验证一下服务是活的。
:::

## 让普通用户也能跑容器

Docker 守护进程通过 Unix socket `/run/docker.sock` 通信，这个 socket 默认属主是 `root`、属组是 `docker`，权限 `rw-rw----`。普通用户直接执行 `docker version` 会报 `permission denied`。

```bash
ll /run/docker.sock
# srw-rw----. 1 root docker ... /run/docker.sock
grep docker /etc/group
# docker:x:981:
```

把用户加进 `docker` 组即可，无需每次 sudo：

```bash
usermod -aG docker a
su - a
docker version
```

`usermod -aG` 的 `-a` 是"追加"，漏掉它会把用户从其他附属组里踢掉，只保留 docker 组。加组后需要**重新登录**会话才生效。`-aG` 后面跟组名，再跟用户名。

## 容器生命周期：创建、运行、进出、停止与删除

容器不是"一上来就跑"，Docker 把它拆成了清晰的几个阶段，对应不同命令。先理解这条主线：

```text
create（创建，不启动）→ start（启动）→ stop（停止）→ rm（销毁）
                         ↑ restart 可重启
```

`docker run` 其实是 create + start 的合并版，最常用：

```bash
# -d 后台运行，-p 把容器 80 端口映射到宿主机 80，-p 后面细讲；--name 起个可读名字
docker container run -d --name apache-httpd-server -p 80:80 httpd:trixie
docker container ls
```

进入运行中的容器用 `exec`，`-it` 表示交互式终端：

```bash
docker container exec -it apache-httpd-server /bin/bash
```

`-i` 保持标准输入打开，`-t` 分配伪终端，两者常一起用。退出交互用 `exit`，容器继续在后台跑。想看容器内进程和日志：

```bash
docker container top apache-httpd-server
docker container logs apache-httpd-server
```

停掉和删掉：

```bash
docker container stop apache-httpd-server
docker container rm -f apache-httpd-server
```

`stop` 是优雅停止（发 SIGTERM），`rm -f` 的 `-f` 是强制删除正在运行的容器（等于先 stop 再 rm）。

把每个动作拆开写，更利于理解生命周期：

```bash
docker container create --name percy ubuntu:22.04
docker container start percy
docker container restart percy
docker container rm -f percy
```

**重启策略**决定容器"意外退出后怎么办"，生产上很关键：

```bash
# always：只要 docker 重启，容器就跟着起来（适合常驻服务）
docker container run --name ubuntu -it --restart always ubuntu:22.04 /bin/bash
# on-failure：只有非正常退出才重启，适合会自己退出的批处理任务
docker container run --name apache-httpd-server -d --restart on-failure -p 80:80 httpd:trixie
```

验证过：`--restart always` 的容器，即使你手动 `stop` 它，只要 `systemctl restart docker` 重启引擎，它又会被拉起来。这一点常让人困惑——想让它真正停，得先 `rm`。

## 镜像管理：拉取、打标签、查看与删除

镜像是容器的模板。理解它的命名规则能少踩很多坑：

```text
[镜像站地址/][项目名称/][镜像仓库/][tag|标签]
```

例如 `docker.io/library/httpd:trixie`，`docker.io` 是镜像站，`library` 是官方项目目录，`httpd` 是仓库，`trixie` 是标签。不写标签时默认是 `latest`。

```bash
# 从官方库拉
docker image pull ubuntu:22.04
# 从非官方库（docker hub 用户仓库）
docker pull redis/redis-stack:7.4.0-v8
# 从 quay.io 这类非 docker hub 的镜像站
docker pull quay.io/sclorg/redis-6-c9s
```

`tag` 不给镜像重命名，而是给同一个镜像再贴一个标签（类似硬链接），常用于推送到私有仓库前改名：

```bash
docker image tag pswed:latest 127.0.0.1:5000/pswed:v1
docker image ls
docker image inspect ubuntu:22.04
docker image rm ubuntu:latest
```

`docker image inspect` 能看到镜像的层级、环境变量、暴露端口等元数据。`rm` 删镜像前，要确保没有容器还在用它——否则会报"有容器依赖此镜像"。

## 用 Dockerfile 把应用变成镜像

真正有价值的是把你自己写的程序做成镜像。素材里用 Pluralsight 的 psweb 示例（一个 Node 小网站）演示。先看它的 Dockerfile：

```dockerfile
FROM alpine
LABEL maintainer="nigelpoulton@hotmail.com"

# 安装 nodejs / npm / curl；Alpine 官方源慢，这里换清华镜像
RUN rm -f /etc/apk/repositories && apk add --update nodejs npm curl \
    --repository=https://mirrors.tuna.tsinghua.edu.cn/alpine/latest-stable/main/ \
    --repository=https://mirrors.tuna.tsinghua.edu.cn/alpine/latest-stable/community/

# 把构建上下文（当前目录）拷进镜像的 /src
COPY . /src
WORKDIR /src

# 装依赖，npm 换国内源
RUN npm install --registry=https://registry.npmmirror.com/

EXPOSE 8080
ENTRYPOINT ["node", "./app.js"]
```

逐行说一下：`FROM` 指定基础镜像，是一切的起点；`RUN` 在构建时执行命令并固化进镜像层；`COPY` 把宿主文件复制进镜像；`WORKDIR` 等于 `cd`，后续命令都在这个目录下；`EXPOSE` 只是"声明"应用监听 8080，不等于自动映射端口；`ENTRYPOINT` 是容器启动时真正跑的命令。

构建并跑起来：

```bash
docker image build -t psweb:latest .
docker container run -d --name psweb -p 8080:8080 psweb:latest
```

`-t` 给镜像命名，`build` 最后的 `.` 是构建上下文目录（Dockerfile 所在目录）。`-p 8080:8080` 把容器 8080 映射出来，浏览器访问宿主机 `8080` 即可看到页面。

### 多阶段构建：让镜像瘦下来

上面 psweb 镜像还行，但素材里的 atsea 商城示例（前端 React + 后端 Spring Boot）如果用"一股脑"方式构建，会体积爆炸——它需要 Node 编译前端、Maven 打包后端，但这些工具最终运行时根本用不到。多阶段构建（multi-stage build）解决这个问题：用多个 `FROM`，每个阶段只干一件事，最后阶段只 `COPY --from` 复制成品。

```dockerfile
# 阶段一：前端编译
FROM node:latest AS storefront
WORKDIR /usr/src/atsea/app/react-app
COPY react-app .
RUN npm install --registry=https://registry.npmmirror.com/
RUN npm run build

# 阶段二：后端打包（用阿里云 Maven 镜像）
FROM registry.cn-hangzhou.aliyuncs.com/acs/maven:3-jdk-8 AS appserver
WORKDIR /usr/src/atsea
COPY pom.xml .
RUN mvn -B -f pom.xml -s /usr/share/maven/ref/settings-docker.xml dependency:resolve
COPY . .
RUN mvn -B -s /usr/share/maven/ref/settings-docker.xml package -DskipTests

# 阶段三：最终运行镜像，只拿成品
FROM ibmjava:8-jre
RUN useradd -m -d /home/gordon gordon
WORKDIR /static
COPY --from=storefront /usr/src/atsea/app/react-app/build/ .
WORKDIR /app
COPY --from=appserver /usr/src/atsea/target/AtSea-0.0.1-SNAPSHOT.jar .
ENTRYPOINT ["java", "-jar", "/app/AtSea-0.0.1-SNAPSHOT.jar"]
CMD ["--spring.profiles.active=postgres"]
```

关键点：`AS storefront` / `AS appserver` 是阶段别名，`COPY --from=storefront` 从指定阶段取文件。最终镜像只基于 `ibmjava:8-jre`，Node 和 Maven 那两层在成品里完全不存在。素材里 atsea 最终镜像 586MB，而如果把 Node（1.63GB）、Maven（945MB）全打进去，体积会翻几倍。

:::note
`ENTRYPOINT` 和 `CMD` 的区别：ENTRYPOINT 是固定启动命令，CMD 是它的默认参数。运行 `docker run <image> 参数` 时，参数会**追加**到 ENTRYPOINT 后面、覆盖 CMD。上例里 `CMD ["--spring.profiles.active=postgres"]` 就是默认激活 postgres 配置，运行时可以换成别的参数。
:::

## 把镜像推到私有仓库

自己做的镜像要给别人或别的机器用，最方便是推到一个私有 registry。先起一个 registry 容器：

```bash
docker container run -d -p 5000:5000 --restart always --name registry registry:3
docker image tag psweb:latest 127.0.0.1:5000/pswed:v1
docker image push 127.0.0.1:5000/pswed:v1
```

`tag` 后的名字 `127.0.0.1:5000/pswed:v1` 里，`127.0.0.1:5000` 是仓库地址，`pswed` 是仓库名，`v1` 是标签。推送后可以从仓库拉回验证：

```bash
docker image rm psweb:latest 127.0.0.1:5000/pswed:v1
docker pull 127.0.0.1:5000/pswed:v1
docker container run -d --name psweb -p 8080:8080 127.0.0.1:5000/pswed:v1
```

注意：这里用的是 `127.0.0.1:5000` 这种"不安全仓库"（HTTP、无证书），跨机器访问需要额外在 `daemon.json` 里加 `insecure-registries`，下一篇 Stack 部署会讲到。

## 踩坑：那些让命令报错的细节

**坑一：docker run 卡在拉取。** 不是网络坏了，是默认源连不上。先配 `daemon.json` 的 `registry-mirrors` 并 `restart docker`。如果环境有代理，也可以走代理访问 `docker.io`，但镜像加速站更省事。

**坑二：普通用户 permission denied。** 报 `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`。把用户加进 docker 组并重新登录。不要用 `sudo` 凑合，那样后续权限和文件属主会乱。

**坑三：镜像过滤命令拼错。** `docker image ls --filter dangling` 会直接报错 `invalid argument "dangling"`，因为过滤器必须是 `name=value` 形式，正确的是 `--filter dangling=true`。另外 `--filter referrnce="*:latest"` 这种拼写错误会报 `invalid filter 'referrnce'`——拼错字段名 Docker 不认，核对拼写。

**坑四：exec 的 -it 放错位置。** 写成 `docker container -it exec percy /bin/bash` 会报 `unknown shorthand flag: 'i' in -it`，因为 `-it` 被解析成了 `container` 子命令的参数。正确写法是 `docker container exec -it percy /bin/bash`，`-it` 紧贴 `exec`。

**坑五：数据随容器存亡。** 在容器里写个文件，比如 `echo "abc test" > test.txt`，只要容器还在，宿主机 `docker` 存储目录里能看到它；一旦 `docker container rm -f percy`，那个文件连同整个可写层一起消失。要数据留下来，必须用数据卷（volume）或 bind mount——这是下一篇网络与存储的重点。

## 速查

```bash
# 安装与加速
dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
# 改 /etc/docker/daemon.json 加 registry-mirrors 后：systemctl restart docker

# 生命周期
docker container run -d --name web -p 80:80 httpd:trixie
docker container exec -it web /bin/bash
docker container stop web && docker container rm web

# 镜像
docker image build -t app:latest .
docker image tag app:latest 127.0.0.1:5000/app:v1
docker image push 127.0.0.1:5000/app:v1
```
