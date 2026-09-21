---
title: 鲲鹏应用迁移实战：从 shell 到 Java，哪些能直接搬、哪些必须重编
description: 把 x86 上的应用搬到 ARM（鲲鹏）平台，第一原则是「二进制不通用，源码通用」。这篇用 shell、Python、C、Java 四种语言各跑一遍迁移，实测哪些改都不用改、哪些必定报 Exec format error，以及 C 源码里那些必须处理的架构差异。
pubDate: 2026-09-21
tags: [鲲鹏, ARM, 信创迁移]
---

信创改造里最常见的一类工作量，就是把 x86 上的应用搬到 ARM 平台（典型是鲲鹏 920）。很多人第一反应是"改代码"，但实际做完一遍会发现：**真正要改的代码很少，卡住人的基本都是编译链路**。

先把第一原则立住：

> **二进制不通用，源码通用。**

编译产物是和指令集绑死的；而是否"源码通用"，取决于这门语言是编译执行还是解释执行。下面用四种语言各跑一遍，这个规律就非常清楚了。

## 实验环境

两台虚拟机，分别是两个架构：

- `x86` 节点：x86_64 架构，openEuler
- `arm` 节点：aarch64 架构（鲲鹏），openEuler

两边都建一个 `/migration` 目录放测试文件，用 `scp` 在两个架构之间传文件。

## Shell 脚本：直接可用

在 x86 上写一个求和脚本：

```bash
#!/bin/bash
SUM=0
for i in {1..100}
do
  let SUM=SUM+i
done
echo $SUM
```

x86 上跑出 `5050`。原样 `scp` 到 arm 节点再跑：

```bash
[root@arm migration]# bash test.sh
5050
```

**一字未改，结果一致。** 因为 shell 脚本由 bash 解释执行，而两边的 bash 都能读懂这段语法——脚本本身不含任何指令集相关的东西。

## Python 脚本：也直接可用

Python 同理。先在两边确认解释器：

```bash
[root@x86 ~]# python3 --version
Python 3.11.6
[root@arm ~]# python3 --version
Python 3.11.6
```

写一个会打印架构信息的脚本：

```python
import platform
import sys

print("Python version:", sys.version)
print("Machine type:", platform.machine())
print("System:", platform.system())

total = sum(range(1, 101))
print("Sum of 1..100 =", total)
```

两边跑出来的**唯一差别**在这一行：

```text
# x86
Machine type: x86_64
# arm
Machine type: aarch64
```

计算结果完全相同。这说明 Python 脚本跨架构迁移基本无痛——**除非代码里有 `platform.machine()` 这类判断架构的逻辑**，那就要检查一下分支是否正确。

:::note
解释型语言的"通用"有一个前提：**运行时的依赖装得上**。如果脚本依赖某个只有 x86 版本的 C 扩展库，那它也会卡住。纯 Python 代码才真正无痛。
:::

## C 语言：源码可移植，但必须重新编译

C 是编译型语言，差别立刻出现。先看源码：

```c
#include <stdio.h>

int main() {
    // 架构识别（迁移时的关键点）
    #if defined(__x86_64__) || defined(__i386__)
        printf("平台：x86 架构\n");
    #elif defined(__arm__) || defined(__aarch64__)
        printf("平台：ARM 架构\n");
    #else
        printf("平台：未知架构\n");
    #endif

    printf("指针大小：%zu 字节\n", sizeof(void*));
    printf("int 大小：%zu 字节\n", sizeof(int));
    return 0;
}
```

在 x86 上编译并运行，正常：

```bash
[root@x86 migration]# gcc test.c -o test_x86
[root@x86 migration]# ./test_x86
平台：x86 架构
指针大小：8 字节
int 大小：4 字节
```

现在把**编译好的二进制**直接拷到 arm 机器上执行：

```bash
[root@arm migration]# ./test_x86
-bash: ./test_x86: cannot execute binary file: Exec format error
```

**`Exec format error` 就是"二进制不通用"的标准报错**。它不是"文件坏了"，而是内核发现这个可执行文件的指令集和当前 CPU 不匹配。

正确的做法是把**源码**拿过去，在 ARM 上重新编译：

```bash
[root@arm migration]# gcc test.c -o test_arm
[root@arm migration]# ./test_arm
平台：ARM 架构
指针大小：8 字节
int 大小：4 字节
```

一编译就过，连源码都不用改——因为代码里已经用 `#if defined(...)` 把架构判断处理好了。

:::warn
看到 `Exec format error` 时，第一反应应该是"**这个二进制是给别的架构编的**"，而不是去查权限或文件完整性。这个报错信息只说了一件事：格式不对。
:::

## Java：字节码竟然直接通用

Java 这里出现了一个反直觉的结果。先编译：

```bash
[root@x86 migration]# javac HelloWorld.java
[root@x86 migration]# ls HelloWorld*
HelloWorld.class  HelloWorld.java
```

`HelloWorld.class` 是字节码。把它**直接拷到 arm 机器**：

```bash
[root@arm migration]# java HelloWorld
Hello, openEuler JDK!
```

**字节码不用重编，跨架构直接跑通。** 原因很清楚：字节码不是机器指令，它跑在 JVM 上，**JVM 负责把字节码翻译成当前 CPU 的指令**。架构差异被 JVM 吸收掉了。

这也是 Java 在信创迁移里口碑最好的原因——**一次编译，哪里都能跑**（前提是目标平台有对应的 JDK）。

:::note
如果反过来在 arm 上编译字节码，拿到 x86 上同样能跑。字节码是架构无关的中间表示。
:::

顺带一个实用技巧：同一台机器上可以装多个 JDK 版本，用 `alternatives` 切换：

```bash
alternatives --config java
```

它会列出所有已注册的 java 程序，输入序号即可切换默认版本。做兼容性验证时很省事。

## 迁移速查：四类语言的结论

| 语言 | 产物类型 | 能否直接搬二进制 | 迁移要做的事 |
|---|---|---|---|
| Shell | 源码（解释执行） | 不存在二进制 | 直接拷源码 |
| Python | 源码（解释执行） | 不存在二进制 | 直接拷源码，检查依赖库 |
| C / C++ | 机器码（编译执行） | **不能** | 拷源码，在目标平台重编 |
| Java | 字节码（JVM 执行） | **能** | 什么都不用做 |

一句话总结：**看它是"编译成机器码"还是"交给运行时"。** 前者必须重编，后者直接搬。

## 踩坑清单

| 现象 | 原因 | 处理 |
|---|---|---|
| `Exec format error` | 二进制来自另一个架构 | 换成源码在目标平台重编 |
| 交叉编译时报 `stdio.h: No such file or directory` | 只有交叉编译器、没有目标平台的库 | 安装完整的交叉编译工具链 |
| C 代码在 arm 上输出异常 | 依赖架构的宏或数据类型没处理 | 用 `#if defined(__aarch64__)` 区分 |
| Python 脚本在 arm 上 import 失败 | 依赖了 x86-only 的 C 扩展 | 换纯 Python 实现或在 arm 上重装依赖 |
| Java 程序能跑但 `javac` 找不到 | 只装了 JRE 没装 devel 包 | 装 `java-1.8.0-openjdk-devel` 之类的开发包 |

## 最后一句

迁移的难点**不在语言，在编译链路和依赖链**。四种语言跑一遍就能建立正确的预期：解释型和 JVM 语言基本无痛，编译型语言的核心工作是"在目标平台把编译环境搭起来"，而不是改代码。
