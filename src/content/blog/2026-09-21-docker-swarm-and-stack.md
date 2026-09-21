---
title: Swarm 集群与 Stack 应用部署：从节点组建到多副本上线
description: 用两台机器组建 Docker Swarm 集群（manager + worker），打通防火墙与自动加锁，再用 docker stack 把 Compose 应用部署成多副本服务并做滚动更新。读完能独立搭一个高可用容器集群，并避开 worker 拉不到镜像、端口没放行这类典型故障。
pubDate: 2026-09-21
tags: [Docker, Swarm, 容器编排]
---

当容器多到一台机器装不下，或者你想让服务挂了自动漂到别的机器，就需要集群。Docker Swarm 是 Docker 自带的集群模式：几台装了 Docker 的机器组成一个集群，你只管声明"要几个副本"，Swarm 自己挑节点调度。这篇用一 manager 一 worker 两台机器，把集群建起来，再用 `docker stack` 把一个 Web+Redis 应用部署成多副本服务。

## Swarm 里的两种角色

集群里节点分两类：

- **manager（管理节点）**：维护集群状态、接收你的调度指令、决定容器跑在哪。可以也跑应用容器，也可以纯管理。
- **worker（工作节点）**：只跑应用容器，真正干活的。

生产建议 **3~5 个 manager** 保证高可用（manager 挂一个集群还能选主），worker 按负载需要加。这篇演示用最小结构：1 manager + 1 worker。文中 IP 统一用 `192.168.1.10`（manager）、`192.168.1.20`（worker）。

## 组建集群前：环境检查

两台机器都要装好 Docker 并启动。检查 CPU、内存、Docker 状态，并互相写好 `/etc/hosts` 方便用主机名：

```bash
# manager 上
lscpu | grep -i on-line      # 在线 CPU 核心数 >= 2
free -h                       # 内存充足
docker version               # Server 段正常
nmcli general hostname manager1-docker
echo 192.168.1.10 manager1-docker >> /etc/hosts
echo 192.168.1.20 worker1-docker >> /etc/hosts
```

worker 如果没装 Docker，从 manager 拷 repo 文件和加速配置过去再装，保证两边环境一致：

```bash
# worker 上（先移除可能的 podman 冲突）
dnf -y remove podman runc
scp root@manager1-docker:/etc/yum.repos.d/docker-ce.repo /etc/yum.repos.d/
scp root@manager1-docker:/etc/docker/daemon.json /etc/docker/
dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker.service
docker version
```

:::note
`daemon.json` 必须两边一致：镜像加速站、私有仓库白名单都要同步。否则 worker 拉镜像的行为会和 manager 不一样，后面部署会踩坑。
:::

## 初始化集群与节点加入

在 manager 上初始化，指定集群通信地址：

```bash
docker swarm init --advertise-addr 192.168.1.10:2377 --listen-addr 192.168.1.10:2377
```

`--advertise-addr` 是告诉其他节点"来这个地址找我"，`--listen-addr` 是本地监听地址。初始化后会打印一条 `docker swarm join ...` 命令，把它里的 token 和地址发给 worker。查看各类加入令牌：

```bash
docker swarm join-token worker   # 拿 worker 加入命令
docker swarm join-token manager  # 拿 manager 加入命令（扩容管理节点用）
docker node ls                   # 看当前节点
```

worker 端执行加入（token 用 init 时给的那串）：

```bash
docker swarm join --token YOUR_SWARM_WORKER_JOIN_TOKEN 192.168.1.10:2377 \
  --advertise-addr=192.168.1.20:2377 --listen-addr=192.168.1.20:2377
# This node joined a swarm as a worker.
```

`YOUR_SWARM_WORKER_JOIN_TOKEN` 是占位，实际替换为 `join-token worker` 输出的完整 token。回 manager 上 `docker node ls` 就能看到两台都 `Ready`。

## 怎么确认节点真的在集群里

`docker node ls` 输出里有几列要会读：`STATUS` 是节点存活状态（`Ready` 正常、`Down` 失联）；`AVAILABILITY` 是调度可用性（`Active` 可接受新任务、`Drain` 不再分配）；`MANAGER STATUS` 只对管理节点有值，`Leader` 是当前主节点。

单台机器上也可用 `docker info | grep -i swarm` 快速判断本节点状态：`Swarm: active` 表示已加入集群，`Swarm: inactive` 表示游离。worker 执行 `docker swarm leave` 后再查就会回到 `inactive`。

## 防火墙：集群通信的命脉

Swarm 节点之间要通几个端口，缺一不可：

| 端口 | 协议 | 用途 |
|---|---|---|
| 2377/tcp | TCP | 集群管理面（raft 共识） |
| 7946/tcp | TCP | 节点间服务发现（serf） |
| 7946/udp | UDP | 节点间服务发现 |
| 4789/udp | UDP | overlay 网络数据面（VXLAN 封装） |

manager 和 worker **都要放行**，而且 `--permanent` 持久化（否则重启防火墙规则就没了）：

```bash
# manager 上
firewall-cmd --add-port=2377/tcp --permanent
firewall-cmd --add-port=4789/udp --permanent
firewall-cmd --add-port=7946/tcp --permanent
firewall-cmd --add-port=7946/udp --permanent
firewall-cmd --reload
firewall-cmd --list-ports
```

```bash
# worker 上同样放行
firewall-cmd --add-port=2377/tcp --permanent
firewall-cmd --add-port=4789/udp --permanent
firewall-cmd --add-port=7946/tcp --permanent
firewall-cmd --add-port=7946/udp --permanent
firewall-cmd --reload
```

:::warn
素材里特别强调：**防火墙状态从安装前到容器运行后要一直保持一致**——要么一直 `active`，要么一直 `inactive`。别装的时候关着、跑应用又开着，这种不一致会让跨节点网络时通时断，最难查。
:::

## 节点维护：退出、加锁与清理

worker 想退出集群：

```bash
docker swarm leave
docker info | grep -A 4 -i swarm
# Swarm: inactive
```

重新加入用上面的 `join` 命令即可。

**自动加锁（autolock）** 是生产必开的安全特性：manager 重启后集群数据是加密的，需要解锁密钥才能恢复。开启：

```bash
docker swarm update --autolock=true
# 会打印一把 SWMKEY-... 解锁密钥，务必单独保存
systemctl restart docker
docker node ls
# Error response from daemon: Swarm is encrypted and needs to be unlocked before it can be used.
docker swarm unlock
# 输入那把密钥
```

如果 manager 非正常重启，不解锁就看不到节点。密钥丢了就彻底无法恢复集群，所以务必存密码管理器。不需要加锁时 `docker swarm update --autolock=false` 关掉。

节点彻底离线后状态会变成 `Down`，要从列表里清掉：

```bash
docker node rm k9o3o0cgpyfp35g8s5kgx90hd   # 用实际的 Down 节点 ID
docker node ls
```

## 用 docker stack 部署多副本应用

Compose 管单机，Stack 管集群。Stack 直接吃 Compose 文件，但加上 `deploy` 段描述副本数、更新策略、放置约束。先准备 `docker-stack.yml`（基于之前的 counter-app）：

```yaml
networks:
  counter-net:
    driver: overlay
    driver_opts:
      encrypted: true

volumes:
  counter-vol:

services:
  web-fe:
    image: manager1-docker:5000/counter-app-web-fs:v1
    command: python app.py
    deploy:
      replicas: 4
      update_config:
        parallelism: 2
        delay: 10s
        failure_action: rollback
      placement:
        constraints:
          - "node.role == worker"
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
        window: 120s
    ports:
      - target: 5000
        published: 5001
    networks:
      - counter-net
    volumes:
      - type: volume
        source: counter-vol
        target: /code
  redis:
    image: "redis:alpine"
    networks:
      counter-net:
```

和单机 Compose 相比，关键差异：

- **`driver: overlay`**：集群跨节点通信必须走 overlay 网络（前提是 Swarm 模式已开）。
- **`encrypted: true`**：overlay 流量加密，跨主机传输更安全。
- **`deploy.replicas: 4`**：web-fe 起 4 个副本，Swarm 自动分散到各节点。
- **`deploy.placement.constraints`**：`node.role == worker` 强制 web 跑在 worker 上，manager 专心管集群。
- **`deploy.update_config`**：更新时每次并行 2 个、间隔 10 秒，失败就回滚——这是滚动更新的安全网。
- **`deploy.restart_policy`**：容器异常退出后延迟 5 秒重启，最多 3 次。

### 把镜像送进私有仓库（worker 才能拉到）

自定义镜像（web-fe）不在官方源，worker 默认拉不到。素材的解决办法是建私有 registry，把镜像推上去，并让 worker 信任这个"不安全仓库"：

```bash
# 确保 registry 在跑（没有就起一个）
docker container run -d -p 5000:5000 --restart always --name registry registry:3
# manager 上给镜像打私有仓库标签并推送
docker image tag counter-app-master-web-fe:latest manager1-docker:5000/counter-app-web-fs:v1
```

`daemon.json` 要加 `insecure-registries`（manager、worker 都要），否则拉 HTTP 仓库会被拒：

```json
{
  "registry-mirrors": [
    "https://docker.1ms.run",
    "https://docker.m.daocloud.io"
  ],
  "insecure-registries": [
    "192.168.1.10:5000",
    "manager1-docker:5000"
  ]
}
```

```bash
systemctl restart docker
docker push manager1-docker:5000/counter-app-web-fs:v1
# 到 worker 上验证能拉到
docker image pull manager1-docker:5000/counter-app-web-fs:v1
```

`insecure-registries` 写 IP 或主机名都行，但必须和推送/拉取时用的地址一致。改完 `daemon.json` 记得 `restart docker` 生效。

### 真正部署

```bash
docker stack deploy -c docker-stack.yml app
docker stack ls
docker stack ps app
docker stack services app
```

`deploy -c` 指定文件，`app` 是 stack 名字（会作为服务名前缀）。`stack ps` 看每个任务（task）落在哪台节点，`stack services` 看服务副本数。素材里 4 个 web-fe 副本全被调度到 `worker1-docker`，redis 在 manager——这正是 `placement` 约束生效的结果。

## 滚动更新与移除

发新版本时，打 `v2` 标签、推仓库、改文件里镜像版本和副本数，再 `deploy` 一次：

```bash
docker image tag manager1-docker:5000/counter-app-web-fs:v1 manager1-docker:5000/counter-app-web-fs:v2
docker image push manager1-docker:5000/counter-app-web-fs:v2
# 改 docker-stack.yml：image 指向 v2，replicas 改 6
docker stack deploy -c docker-stack.yml app
docker stack ps app
```

Swarm 会按 `update_config` 滚动替换：每次并行 2 个、间隔 10 秒，旧的标 `Shutdown`、新的 `Running`。如果新副本起不来，`failure_action: rollback` 会把整批回滚到上一版，不会让服务整体挂掉。

移除应用（容器 + 网络被删，数据卷需手动清）：

```bash
docker stack rm app
docker stack ls
docker volume ls   # 卷还在，手动 docker volume rm 才删
```

## 踩坑：集群里最常见的几个故障

**坑一：worker 拉不到自定义镜像。** 报找不到镜像或连接被拒。根因有两个：镜像没推到私有 registry，或 worker 的 `daemon.json` 没把仓库加进 `insecure-registries`。两边 `daemon.json` 必须一致且 `restart docker` 生效，再到 worker 上 `docker image pull` 实测一把。

**坑二：防火墙端口没全放行，跨节点网络不通。** overlay 数据面走 4789/udp，控制面走 2377/7949 等。素材里关掉 firewalld 后跨节点 ping 立刻从 100% 丢包变通，就是端口被挡的典型表现。务必 2377/tcp、4789/udp、7946/tcp+udp 四个都放行且 `--permanent`。

**坑三：manager 重启后 node ls 报"Swarm is encrypted"。** 开了 autolock 却没保存解锁密钥。重启后 `docker swarm unlock` 输密钥即可。建议把密钥存密码管理器，并且只在确实需要的场景开 autolock。

**坑四：防火墙状态前后不一致。** 装系统时关着、部署时开着，或反过来，会导致 overlay 网络时通时断。保持安装前到运行后防火墙状态一致，最省心。

## 速查

```bash
# manager 初始化
docker swarm init --advertise-addr 192.168.1.10:2377 --listen-addr 192.168.1.10:2377
docker swarm join-token worker     # 拿 worker 加入命令

# worker 加入
docker swarm join --token <token> 192.168.1.10:2377 \
  --advertise-addr=192.168.1.20:2377 --listen-addr=192.168.1.20:2377

# 防火墙
firewall-cmd --add-port=2377/tcp --permanent
firewall-cmd --add-port=4789/udp --permanent
firewall-cmd --add-port=7946/tcp --permanent
firewall-cmd --add-port=7946/udp --permanent
firewall-cmd --reload

# 部署与运维
docker stack deploy -c docker-stack.yml app
docker stack ps app
docker stack services app
docker stack rm app
```
