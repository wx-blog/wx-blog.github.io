---
title: 容器网络与数据持久化：bridge/overlay 驱动与三种卷的正确用法
description: 理清 Docker 内置网络驱动（bridge/host/none/overlay）的取舍与容器名互通、端口映射的坑，再讲清数据持久化的三条路（匿名卷、命名卷、bind mount）和数据库卷的备份恢复。读完能为多容器应用选对网络、为状态数据选对存储，避开 SELinux 与防火墙挡路的典型故障。
pubDate: 2026-09-21
tags: [Docker, 容器网络, 存储]
---

容器跑起来后，紧接着两个绕不开的问题：容器之间怎么通信？容器里的数据怎么活得比容器久？网络管"连不连得通"，存储管"删了容不容易丢"。这篇把 Docker 的内置网络驱动和三类数据卷一次讲透，命令都来自实操记录。

## 通信场景与内置驱动

容器通信大致三种场景：同一台宿主机内容器互访、跨宿主机容器互访、容器访问外部。Docker 内置驱动对应不同需求：

| 驱动 | 作用 |
|---|---|
| `bridge` | 默认驱动，单宿主机内容器通过虚拟网桥互通，支持端口映射 |
| `host` | 取消容器与宿主的网络隔离，直接用宿主网络栈 |
| `none` | 完全隔离，只有回环口 |
| `macvlan` / `ipvlan` | 容器直接挂到物理网络，按 MAC/IP 划分 VLAN |
| `overlay` | 跨宿主机连容器，需 Swarm 模式，VXLAN 封装 |

单机最常用 `bridge`，跨节点必须 `overlay`。

## bridge 网络：自建 bridge 才能用容器名互访

装好 Docker 会有一个默认 `bridge` 网络（名为 `docker0`，网段 `172.17.0.0/16`）。它的特性是：支持通过地址转换访问外网、支持端口发布，但**默认 bridge 里容器不能用名字互相访问**，只能用 IP。

自建一个 bridge 网络就不一样了——自建 bridge 内置 DNS，容器名可以直接解析：

```bash
docker network create --driver bridge mynet
docker run -dit --name c1 --network mynet alpine:latest
docker run -dit --name c2 --network mynet alpine:latest
docker exec c1 ping -c 3 c2        # 通，按名字解析到 172.18.0.3
docker exec c2 ping -c 3 c1        # 通
docker exec c1 ping -c 3 8.8.8.8   # 通，能上外网（靠 IP 伪装）
```

默认 bridge 想用名字通信，只能靠老式的 `--link`，而且还是单向的：

```bash
docker container run --name c4 -dit --link c3 alpine:latest
docker container exec c4 ping -c 2 c3   # 通
docker container exec c3 ping -c 2 c4   # bad address 'c4'，反向不通
```

`--link` 已被官方标记为遗留用法，新建网络请直接用自建 bridge。还可以把运行中的容器接到别的网络：

```bash
docker network create --driver bridge --subnet 172.21.0.0/24 --gateway 172.21.0.1 new-net
docker network connect new-net c3
docker network connect new-net c2
docker container exec c2 ping -c 2 c3     # 通
docker network disconnect new-net c3
docker container exec c2 ping -c 2 c3     # bad address 'c3'
```

删网络前必须先把容器断开，否则报 `network new-net has active endpoints`：

```bash
docker network disconnect new-net c2
docker network rm new-net
```

## 端口映射：让外部访问容器

`-p`（即 `--publish`）把容器端口映射到宿主机。注意映射地址的影响：

```bash
docker container run --name httpd -p 127.0.0.1:80:80 -d httpd:latest
docker port httpd
# 80/tcp -> 127.0.0.1:80
curl 127.0.0.1:80     # 通
curl 192.168.1.10:80  # Failed to connect to 192.168.1.10 port 80
```

`-p 127.0.0.1:80:80` 把端口只绑在回环地址，所以只有本机能访问；外部用宿主机 IP 访问会被拒。要对外暴露，要么写 `-p 80:80`（等价绑 `0.0.0.0`），要么显式 `-p 0.0.0.0:80:80`。

## host 与 none 驱动

`host` 模式下容器直接共享宿主网络命名空间，看不到独立的 `eth0`，`ip a s` 看到的是宿主的网卡：

```bash
docker container run -it --name c5 --network host alpine:latest
ip a s    # 直接列出 ens160、docker0 等宿主接口
```

好处是网络性能最好（无 NAT 开销），坏处是端口和宿主冲突、隔离性为零，一般只给对性能极敏感或需要抓宿主流量的场景用。`none` 则彻底断网，只剩 `lo`，适合纯计算、不需要联网的批处理：

```bash
docker container run -it --name c6 --network none alpine:latest
ip a s    # 只有 lo
```

## overlay 跨节点：Swarm 之上的虚拟网络

overlay 让分布在不同宿主的容器像在同一交换机上。前提是集群已建好（见 Swarm 篇），并且节点间端口放行。在 manager 上建一个 overlay 网络并起服务：

```bash
docker service create --name test --network uber-net --replicas 2 alpine:latest sleep 3600
docker service ps test
docker network inspect uber-net
```

`network inspect` 里 `Scope` 是 `swarm`、`Driver` 是 `overlay`、`Peers` 会列出参与的节点 IP。overlay 数据面用 VXLAN 把容器帧封装进 UDP 走底层网络，控制面维护虚拟拓扑。

更实用的是服务发现与负载均衡：把一个 6 副本的 web 服务用 overlay 暴露，外部访问 manager 的发布端口，请求会被 VIP + routing mesh 分摊到不同副本：

```bash
# 在另一节点循环访问
for i in $(seq 6); do curl 192.168.1.10:5001; done
# 日志里能看到请求落到 app_web-fe.1 ~ .6 不同副本
```

这就是"一个服务名，多个副本，自动负载均衡"的效果，对外只暴露一个端口。

## 数据持久化：先认清容器数据会随容器消亡

不挂卷时，容器写的数据存在它自己的可写层（overlayfs）里。它经得起 `stop`/`start`，但 `rm` 就彻底没了：

```bash
docker container run -d --name httpd_1 httpd:latest
docker container exec -it httpd_1 /bin/bash
rm -f htdocs/index.html
echo "remove default index file" >> htdocs/index.html
exit
docker container stop httpd_1 && docker container start httpd_1   # 改动还在
docker container rm httpd_1                                      # 可写层被删
ls /var/lib/docker/rootfs/overlayfs/<容器ID>                      # 目录已不存在
```

所以"需要留的数据"必须挂卷。Docker 提供三种挂法。

## 三兄弟：匿名卷、命名卷、bind mount

**匿名卷**：只用 `--volume source=名字,target=路径`，没先建卷，Docker 自动生成一串 hash 当卷名：

```bash
docker container run --name httpd_2 -d --volume source=apache,target=/usr/local/apache2/htdocs httpd:latest
docker volume ls    # 出现 2a763fa5... 这类匿名卷
docker volume inspect 2a763fa5...   # Labels 里有 com.docker.volume.anonymous
```

匿名卷能持久化，但名字是乱码，容器删了之后很难再关联回哪个应用，管理起来头疼。**命名卷**更推荐：

```bash
docker volume create http_vol
docker container run -d --name httpd_3 -v http_vol:/usr/local/apache2/htdocs httpd:latest
# 只读挂载：容器里写会报 Read-only file system
docker container run -d --name http-5 -v http_vol:/usr/local/apache2/htdocs:ro httpd:latest
```

命名卷有可读名字，多个容器可共用同一个卷（如 web 多副本共享静态资源），`:ro` 还能把卷设为只读保护数据。`-v` 是老写法，`--mount` 更明确、支持更多特性：

```bash
mkdir /var/http_vol
echo "docker host dir without docker volume" >> /var/http_vol/test.html
docker container run -d --name http-1 --mount type=bind,src=/var/http_vol,dst=/usr/local/apache2/htdocs httpd:latest
```

**bind mount** 把宿主机的某个目录直接挂进容器，容器内写文件立刻反映到宿主目录，适合"配置文件要宿主机随时改、日志要宿主机直接看"的场景。缺点是绕过了 Docker 的管理，权限和路径都得自己负责。

## 数据库卷的备份与恢复

以 MySQL 为例。先起一个临时容器初始化数据，数据写进命名卷：

```bash
docker volume create mysql-init-data
docker container run -d --name mysql-init -e MYSQL_ROOT_PASSWORD=123.com \
  -v mysql-init-data:/var/lib/mysql mysql:8.4
docker container logs mysql-init
# 看到 "MySQL init process done. Ready for start up." 说明就绪
docker exec -it mysql-init mysql -uroot -p'123.com'
# 建库建表插数据后退出
```

`docker logs` 里出现 "Ready for start up" 是判断数据库可用的最可靠信号，别上来就连。初始化完，把卷里数据清空 `auto.cnf` 和 `mysql.sock` 这两个运行时文件，再交给生产容器复用——否则新容器可能读到旧的 server-uuid 或失效的 socket 软链接：

```bash
docker container stop mysql-init && docker container rm mysql-init
rm -f /var/lib/docker/volumes/mysql-init-data/_data/auto.cnf
rm -f /var/lib/docker/volumes/mysql-init-data/_data/mysql.sock
docker container run --name mysql-prod -d -v mysql-init-data:/var/lib/mysql -e MYSQL_ROOT_PASSWORD=123.com mysql:8.4
docker exec -it mysql-prod mysql -uroot -p123.com -e "select * from appdb.users;"
```

整卷备份用 `--volumes-from` 把一个临时 alpine 容器挂到目标卷，再用 `tar` 打包出来：

```bash
docker container run --rm --name backup --volumes-from mysql-prod \
  -v /backup:/backup alpine:latest tar -czf /backup/mysql_backup.tar.gz /var/lib/mysql
ls /backup/    # mysql_backup.tar.gz
```

恢复时反过来，把包解开进一个空卷的挂载点，再用这个卷起容器：

```bash
docker container run --rm --name restore --volumes-from mysql-empty \
  -v /backup:/backup alpine:latest tar -xzf /backup/mysql_backup.tar.gz -C /
docker container run --name mysql-empty -d -v mysql-empty:/var/lib/mysql -e MYSQL_ROOT_PASSWORD=123.com mysql:8.4
docker container restart mysql-empty    # 必要时重启让库被重新识别
docker exec -it mysql-empty mysql -uroot -p123.com -e "show databases;"
```

:::note
用 MySQL 8.4 时建表语法要严格：`TIMESTAMP` 不能裸写 `DEFAULT` 缺值，`insert` 多行要用 `values(),(),()` 形式，否则会报 1064/1136 语法错误。这是素材里实打实踩过的，和 Docker 无关但容易卡在初始化步骤。
:::

## 踩坑：网络与存储的典型故障

**坑一：SELinux 挡住卷内容。** 宿主是 `Enforcing` 模式时，容器写进卷的文件，宿主机 `ls` 可能看不到；反过来宿主往卷目录写的文件，容器里也看不到。素材里 `setenforce 0` 临时关掉就通了。生产上别直接关 SELinux，正确做法是用 `chcon` 给卷目录打上容器可访问的标签，或挂卷时加 `:z` / `:Z` 让 Docker 自动修正上下文。

**坑二：端口只绑了 127.0.0.1。** `-p 127.0.0.1:80:80` 外部访问报 `Connection refused`。要对外暴露用 `-p 80:80`。排查端口问题先看 `docker port 容器名`，确认绑定的是 `0.0.0.0` 还是某个具体 IP。

**坑三：默认 bridge 里容器名 ping 不通。** 报 `bad address 'c3'`。默认 bridge 不做 DNS，要么用 `--link`（不推荐），要么把容器放进自建 bridge 网络。

**坑四：防火墙挡住 overlay，跨节点 100% 丢包。** 素材里关掉 firewalld 之前，跨节点 ping 一直 `100% packet loss`，关掉立刻通则说明是端口没放行。overlay 需要 2377/tcp、7946/tcp+udp、4789/udp 全开且持久化（见 Swarm 篇）。

**坑五：匿名卷难管理。** 名字是一串 hash，容器删了之后卷还在但无从对应。能命名就命名，别依赖匿名卷。数据库复用卷记得清 `auto.cnf` 和 `mysql.sock`，恢复后必要时 `restart` 让库重新加载。

## 速查

```bash
# 网络
docker network create --driver bridge mynet
docker run -dit --name c1 --network mynet alpine:latest
docker network connect new-net c2
docker network disconnect new-net c2 && docker network rm new-net
docker container run --name httpd -p 80:80 -d httpd:latest   # 对外暴露

# 卷
docker volume create http_vol
docker container run -d --name web -v http_vol:/data httpd:latest
docker container run -d --mount type=bind,src=/var/www,dst=/usr/local/apache2/htdocs httpd:latest

# 数据库备份
docker container run --rm --volumes-from mysql-prod -v /backup:/backup alpine \
  tar -czf /backup/mysql_backup.tar.gz /var/lib/mysql
```
