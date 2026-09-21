---
title: Shell 基础与文本处理：从 loop 挂载、grep 正则到 Shell 脚本
description: 从 shell 种类、提示符与 history 等命令行效率，到把文件当磁盘挂载的 loop 设备与按需 automount，再到 grep/egrep 正则与 Shell 脚本的变量、循环、判断，并点出变量拼接、"$*"与"$@"、loop 文件大小等踩坑。
pubDate: 2026-09-21
tags: [Linux, Shell, 文本处理]
---

Shell 是你和 Linux 内核之间的翻译层，而文本处理是运维的日常。这篇把三块常被割裂的内容揉到一起：怎么把 Shell 用得更顺手、怎么把普通文件当成磁盘挂起来、以及 grep/脚本这些「处理文本和批量干活」的基本功。

## Shell 是什么，有哪几种

系统里装了哪些 shell，看 `/etc/shells` 就知道：

```bash
cat /etc/shells
```

常见的 `sh`、`bash`、`ksh` 都在里面。切换 shell 直接敲名字（如 `ksh`），装新 shell 用 `yum -y install ksh`。日常默认基本都是 `bash`，下面的技巧也以 bash 为准。

## 让命令行更高效：提示符与 history

提示符由环境变量 `PS1`（主提示符）、`PS2`（续行提示符）控制，临时改一下立刻生效：

```bash
PS1='\u@\h \W \$ '      # 用户名@主机 当前目录 #
echo $PS2               # 默认是 >
PS2=%                   # 改续行符为 %
```

`history` 是排查「我刚才到底敲了啥」的神器：

```bash
history              # 最近 1000 条
history -c           # 清空当前会话历史
!!                  # 执行上一条命令
!n                  # 执行第 n 条
!string             # 执行最近以 string 开头的命令
^old^new            # 把上一条命令的 old 换成 new 再执行
```

多终端共享历史，在 `~/.bashrc` 里加：

```bash
export HISTCONTROL=ignoreboth          # 忽略重复和以空格开头的命令
shopt -s histappend                    # 追加而非覆盖历史文件
```

:::note
交互式搜索历史用 `Ctrl+R`，输入关键词反向匹配，再按 `Ctrl+R` 继续往前翻。这是比翻滚动条快得多的操作。
:::

## 把文件当磁盘用：loop 设备与按需挂载

有时候你不想动真实分区，只想把一个大文件当作块设备来格式化、挂载——比如做实验、做镜像。`dd` 先造一个文件，再格式化成文件系统：

```bash
dd if=/dev/urandom of=/file1 bs=50M count=10
mkfs.xfs /file1          # xfs 不能低于 300M，文件太小会失败
```

挂载时加 `-o loop`，内核会帮你找一个空闲 loop 设备：

```bash
mkdir /file_mount
mount -o loop /file1 /file_mount
df -h /file_mount
```

要开机自动挂，写进 `/etc/fstab`，关键就是 `loop` 选项：

```bash
/file1 /file_mount xfs defaults,loop 0 0
systemctl daemon-reload
```

### 按需挂载（automount）

一直挂着浪费资源，更优雅的是「访问时才挂、闲置后自动卸」。最简单的方式是在 fstab 选项里加 `x-systemd.automount`：

```bash
/file1 /mountdir/file1dir xfs defaults,loop,x-systemd.automount 0 0
systemctl daemon-reload
systemctl start mountdir-file1dir.automount
```

启动后 `df` 还看不到它，只有你 `ls /mountdir/file1dir/` 触发访问，挂载才发生。

也可以纯靠单元文件实现。先 `losetup` 把文件绑到 loop 设备，再写 `.mount` 和同名 `.automount` 单元放到 `/usr/lib/systemd/system/`：

```bash
losetup -f --show /file1        # 输出 /dev/loop0
```

```ini
# mountdir-file1dir.mount
[Mount]
What=/dev/loop0
Where=/mountdir/file1dir
Type=xfs
```

```ini
# mountdir-file1dir.automount
[Automount]
Where=/mountdir/file1dir
[Install]
WantedBy=multi-user.target
```

```bash
cp mountdir-file1dir.* /usr/lib/systemd/system/
systemctl daemon-reload
systemctl enable --now mountdir-file1dir.automount
```

## 文本处理：grep / egrep 正则实战

`grep` 找行，`egrep`（即 `grep -E`）支持扩展正则，是筛日志、查配置的主力。

```bash
grep root passwd              # 含 root 的行
grep -n root passwd           # 带行号
grep -rn 'root' .             # 递归当前目录
```

词边界 `\b` 和取反 `-v`、忽略大小写 `-i`：

```bash
egrep 'abc\b' 1.txt           # 匹配 abc 但后面是词边界（不匹配 abc123）
egrep -v 'abc\b' 1.txt        # 反向：不含词边界 abc 的行
egrep -i 'abc\b' 1.txt        # 忽略大小写
```

量词（重复次数）是最常用的：

```bash
egrep 'o{3,}' 1.txt           # o 出现至少 3 次
egrep 'o{2}' 1.txt            # o 出现至少 2 次
```

## Shell 脚本入门：变量、循环与判断

### 变量与内置变量

变量赋值不用空格，`$变量名` 取值。拼接时容易踩坑：

```bash
A=100
echo $A100        # 空！shell 把 A100 当成一个新变量名
echo ${A}100      # 100100，用 {} 隔离变量名
```

脚本的内置变量很常用：`$0` 脚本名、`$1~$9` 参数、`$#` 参数个数、`$*`/`$@` 全部参数。

```bash
#! /bin/bash
echo '$0:' $0
echo '$1:' $1
echo '$#:' $#
echo '$*:' $*
echo '$@:' $@
```

`"$*"` 把所有参数拼成一个字符串，`"$@"` 保留每个参数独立。循环里差别明显：

```bash
for i in "$*"; do echo "$i"; done   # 整个 "1 2 3 4" 当作一个元素
for i in "$@"; do echo "$i"; done   # 1 / 2 / 3 / 4 各一行
```

### 判断与循环

`if` 用 `[ ]` 做测试（`-gt` 大于、`-eq` 等于）：

```bash
if [ "$1" -gt 3 ]; then echo '>'
elif [ "$1" -eq 3 ]; then echo '='
else echo '<'; fi
```

`while` 和 `for` 覆盖绝大多数批量场景：

```bash
i=1
while [ $i -le 5 ]; do echo "i = $i"; i=$((i+1)); done

for i in 1 2 3 4 5; do echo "当前数字是 $i"; done
for i in $(seq 1 5); do echo "当前数字是 $i"; done
for i in $(seq 1 3 10); do echo "当前数字是 $i"; done   # 1 4 7 10
```

`case` 适合多分支菜单：

```bash
read -p "请输入1-3的数字：" num
case $num in
  1) echo "你输入了1" ;;
  2) echo "你输入了2" ;;
  3) echo "你输入了3" ;;
  *) echo "输入不符合要求" ;;
esac
```

## 踩坑

**坑一：`echo $A100` 输出为空。** Shell 会把 `A100` 整体当成变量名去查，自然查不到。凡是变量名后面紧跟字母/数字，一律用 `${A}` 把边界框清楚。

**坑二：`"$*"` 和 `"$@"` 在循环里不是一回事。** 想逐个处理参数用 `"$@"`；用 `"$*"` 会把所有参数黏成一项，循环只跑一次。

**坑三：loop 文件格式化 xfs 有大小下限。** 素材实测 `mkfs.xfs /file1` 在文件过小时会失败，记住 xfs 不能低于约 300M，造文件时 `count` 给足。

**坑四：fstab 已经写了 `loop`，再手动 `mount` 会报 already mounted。** 因为 systemd 已经按 fstab 接管了该挂载点，重复挂会提示「is already mounted」。加完 fstab、`daemon-reload` 后直接用目录访问即可，不必再手敲 `mount`。

**坑五：`egrep` 才认 `{3,}` 这类扩展量词。** 用老 `grep` 写 `o{3,}` 会被当成普通字符，要么换 `egrep`/`grep -E`，要么给 grep 加 `-E`。

## 速查

```bash
# Shell 效率
cat /etc/shells
history ; !! ; !n ; ^old^new
Ctrl+R                 # 交互搜历史

# loop 设备
dd if=/dev/urandom of=/file1 bs=50M count=10
mkfs.xfs /file1
mount -o loop /file1 /file_mount
# fstab: /file1 /file_mount xfs defaults,loop,x-systemd.automount 0 0

# 文本处理
grep -n root passwd
egrep 'o{3,}' 1.txt
egrep -i 'abc\b' 1.txt

# 脚本内置变量
# $0 脚本名  $1 第1参数  $# 参数个数  "$@" 独立参数列表
```
