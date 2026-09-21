---
title: Docker Compose 多容器编排实战：用一份 YAML 拉起 Web+Redis
description: 以一个 Redis 计数应用为例，讲清 Docker Compose 的 YAML 结构、services/networks/volumes 三大顶层字段，以及 up/down/ps/scale 等常用命令。读完能用一份配置文件管理多个互相通信的容器，并避开端口冲突这类典型报错。
pubDate: 2026-09-21
tags: [Docker, Compose, 容器编排]
---

单个容器用 `docker run` 还能应付，但真实应用往往是"前端 + 后端 + 数据库"好几个容器一起跑。Docker Compose 用一个 YAML 文件声明这些容器怎么组合、怎么连网、数据存哪，再一条 `docker compose up` 全部拉起。这篇用一个 Redis 计数小应用（counter-app）把流程走通。

为什么不直接写个脚本循环 `docker run`？三个容器还好，十个容器时，谁先起、网络怎么连、数据挂哪、挂了怎么一起停，全要自己编排。Compose 把这些写成声明式配置，命令从 `docker run` 的"动词"变成配置的"名词"，可读、可纳入版本管理、可一键复现。

## 先确认 Compose 插件已装

新版 Docker 把 Compose 做成插件（plugin），不是独立二进制。装 Docker 时带上 `docker-compose-plugin` 就有了：

```bash
rpm -qa | grep docker
# docker-compose-plugin-5.1.3-1.el10.x86_64 等
docker compose version
# Docker Compose version v5.1.3
```

:::note
命令是 `docker compose`（空格），不是老的 `docker-compose`（横线）。老写法在新版插件里也能兼容，但建议统一用空格版，避免脚本里混用。
:::

## YAML 长什么样：先懂语法再读配置

Compose 文件是 YAML，规则就三条，记牢就不会写错：

```yaml
# 1. 键值对：冒号后必须一个空格
banana: yellow
apple: green

# 2. 层级靠缩进（通常用 2 个空格），不是大括号
apple:
  color: red
  flavor: sweet

# 3. 列表项用短横线
fruits:
  - apple
  - strawberry
  - blueberry
```

缩进错一格，整个文件解析就乱。写完不放心可以 `docker compose -f 文件 up --dry-run` 先跑一遍干跑检查。配置文件用 `.yml` 或 `.yaml` 后缀都行，团队里统一一种即可，Compose 都能识别。

## counter-app 的配置文件逐段拆

应用由两个服务组成：`web-fe`（Flask 网站）和 `redis`（内存数据库，记录访问次数）。完整 `docker-compose.yml` 如下：

```yaml
version: "3.5"    # api 版本（新版已弃用，见踩坑）
services:
  web-fe:
    build: .
    command: python app.py
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

networks:
  counter-net:

volumes:
  counter-vol:
```

逐段解释：

- **`services`** 是核心，列出应用由哪些"服务"（容器）组成。`web-fe` 和 `redis` 是自定义服务名。
- **`build: .`** 表示 web-fe 的镜像从当前目录的 Dockerfile 现场构建；`redis` 用现成镜像 `redis:alpine`。
- **`command`** 覆盖容器启动命令，这里指定跑 `python app.py`。
- **`ports`** 做端口映射：`target` 是容器内端口，`published` 是宿主机映射端口。注意素材里 published 是 `5001`，不是 5000——原因在踩坑里。
- **`networks`** 把服务挂到 `counter-net` 网络上。网络若没显式声明，Compose 会自动建一个并把相关服务接进去；这里在顶层 `networks` 手动声明，是为了显式控制网络的存在与归属，避免被 `down` 误删或和其他项目混淆。
- **`volumes`** 给 web-fe 挂一个数据卷 `counter-vol`，挂载到容器 `/code`。顶层 `volumes` 声明这个卷。

为什么 web-fe 能直接 `redis` 当主机名连数据库？看应用代码：

```python
import time
import redis
from flask import Flask

app = Flask(__name__)
cache = redis.Redis(host='redis', port=6379)

def get_hit_count():
    retries = 5
    while True:
        try:
            return cache.incr('hits')
        except redis.exceptions.ConnectionError as exc:
            if retries == 0:
                raise exc
            retries -= 1
            time.sleep(0.5)

@app.route('/')
def hello():
    count = get_hit_count()
    return "What's up Docker Deep Divers! You've visited me {} times.\n".format(count)

if __name__ == "__main__":
    app.run(host="0.0.0.0", debug=True)
```

`host='redis'` 就是服务名。Compose 会给同一网络里的服务做 DNS 解析，所以容器之间用服务名互访，不用管 IP。代码里还写了重试逻辑：连不上 redis 时最多试 5 次、每次等 0.5 秒——这正好兜住了"web 比 redis 先起来"的时序问题。

## 容器名是怎么来的

跑起来后 `docker compose ps` 看到的容器名不是随便起的，规则是：`项目名_服务名_序号`。项目名默认取自配置文件所在目录名（比如目录叫 `counter-app-master`，项目名就是它），服务名是 YAML 里 `services` 下的键，序号从 1 递增。所以你会看到 `counter-app-master-redis-1`、`counter-app-master-web-fe-1` 这种名字。

记住这个规则有用：日志、进容器、连数据库时，用的都是这个全名，而不是你直觉里的"redis"。`docker compose exec redis ...` 也能用服务名直接操作，不用背全名。

## 一条命令拉起整个应用

必须在 `docker-compose.yml` 所在目录执行，Compose 默认读当前目录的配置文件：

```bash
docker compose up -d
docker compose ps
docker compose images
docker compose logs web-fe
```

`up -d` 的 `-d` 是后台运行；它会自动完成"构建/拉取镜像 → 建网络和数据卷 → 起容器"。`ps` 看服务状态，`images` 看用了哪些镜像，`logs 服务名` 看单个服务的输出。

`up` 成功后 `docker compose ps` 大致是这样（端口已改 5001）：

```bash
NAME                          IMAGE                       COMMAND        SERVICE   STATUS    PORTS
counter-app-master-redis-1    redis:alpine                "docker-..."   redis      Up       6379/tcp
counter-app-master-web-fe-1   counter-app-master-web-fe   "python app.py" web-fe    Up       0.0.0.0:5001->5000/tcp
```

## 管理运行中的应用

停掉但保留容器和数据卷：

```bash
docker compose stop
docker compose start
```

`stop` 后 `ps -a` 能看到状态是 `Exited`，`start` 再拉起。彻底移除应用（容器 + 网络），但**保留数据卷**：

```bash
docker compose down
docker volume ls
```

`down` 之后 `docker volume ls` 里 `counter-app-master_counter-vol` 还在——这是 Compose 的默认行为：数据卷比容器"长寿"，防止误删数据。要连卷一起删得加 `--volumes`。

扩缩容（调整某服务的副本数）：

```bash
docker compose scale redis=3
docker compose ps
docker compose top
docker compose stats
```

`scale redis=3` 把 redis 从 1 个扩到 3 个；`top` 看各服务容器内进程；`stats` 看 CPU/内存占用。注意 `stats` 是实时刷新，用 `Ctrl+C` 退出。

## 常用子命令速览

`docker compose` 的子命令覆盖应用全生命周期，记这几个最高频的：

- 构建与运行：`build`（只构建镜像）、`up`（构建+启动）、`up -d`（后台启动）
- 状态查看：`ps`（容器状态）、`images`（镜像列表）、`logs 服务名`（某服务日志）、`top`（进程）、`stats`（CPU/内存）
- 启停与扩缩：`start` / `stop` / `restart` / `scale 服务=数`
- 进容器与清理：`exec`（在容器内执行命令）、`down`（删容器+网络，卷保留）、`rm`（删已停止的容器）

素材里还用到 `events`（实时事件流）和 `-f` 指定配置文件路径，复杂排障时很有用。一条原则：几乎所有子命令都默认作用在"当前目录的配置文件"上，换个目录前要么 `cd` 进去，要么用 `-f` 指绝对路径，否则会报 `no configuration file provided`。

## 踩坑：端口被占用与过时写法

**坑一：Bind for :::5000 failed: port is already allocated。** 这是素材里实打实踩过的。第一次 `up` 报这个错，因为宿主机 5000 端口早被另一个 registry 容器占着。解决就是改 `published`：

```yaml
ports:
  - target: 5000
    published: 5001    # 改成没被占用的宿主机端口
```

改完重新 `docker compose up -d` 就通了。排查思路：`docker container ls` 看所有容器映射了哪些端口，避开冲突的就行。不要指望 Docker 自动换端口。

**坑二：version 属性已弃用。** 启动时会有警告：

```text
WARN[0000] /build/counter-app-master/docker-compose.yml: the attribute `version` is obsolete, it will be ignored, please remove it to avoid potential confusion
```

新版本 Compose 不再需要 `version` 字段，写上只是被忽略并给警告。新项目直接删掉这一行最干净。保留也不会错，但看着碍眼。

**坑三：不在配置文件目录就找不到文件。** 素材里在别处执行 `docker compose stats` 直接报 `no configuration file provided: not found`。Compose 默认读当前目录的配置，换目录前要么 `cd` 进去，要么用 `-f` 指定绝对路径：

```bash
docker compose -f /build/counter-app-master/docker-compose.yml stats
```

**坑四：redis 连不上的时序。** 如果 web-fe 一启动就崩，八成是连 redis 失败且没重试。素材的 app.py 写了 5 次重试兜底，正式写应用也建议加上——容器启动顺序不保证，依赖方要有重试或等待逻辑。

## 速查

```bash
# 在 docker-compose.yml 所在目录
docker compose up -d          # 构建并后台启动
docker compose ps             # 看状态
docker compose logs web-fe    # 看某服务日志
docker compose scale redis=3  # 扩副本
docker compose stop           # 停（保留容器/卷）
docker compose start          # 起
docker compose down           # 删容器+网络（卷保留）
docker compose down --volumes # 连卷一起删
```
