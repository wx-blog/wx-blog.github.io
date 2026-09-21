---
title: x86 上编译 ARM 程序：本地编译、交叉编译与鲲鹏专用编译器
description: 在 x86 机器上产出 ARM 可执行文件，有三条路：在目标机上编译、交叉编译、以及用厂商优化过的编译器。这篇把三条路都跑一遍，讲清交叉编译装完编译器为什么还缺 stdio.h、交叉产物为什么在本机跑不了，以及 GCC for openEuler 的差异。
pubDate: 2026-09-21
tags: [鲲鹏, ARM, 编译]
---

上一篇讲了迁移的基本原则——编译型语言的程序必须到目标平台重编。那有没有办法**在 x86 上直接产出 ARM 能跑的可执行文件**？有，这叫交叉编译。但实际做起来会发现，装完交叉编译器并不等于就能编。

这篇把三条路都跑通，并且说清每条路上会在哪里卡住。

## 三条路，先选清楚

| 路径 | 在哪编译 | 产物给谁跑 | 适用场景 |
|---|---|---|---|
| **本地编译（x86）** | x86 机器 | x86 机器 | 只测 x86 |
| **本地编译（ARM）** | ARM 机器 | ARM 机器 | 最稳，但要有一台 ARM 机器 |
| **交叉编译** | x86 机器 | ARM 机器 | 没有 ARM 机器、或要批量构建 |

交叉编译的价值就是第三条：**手上只有 x86 的构建机，但要产出 ARM 的包**。

## 路径一：在 ARM 机器上直接编译（基准）

这是最简单也最不容易出错的路径。源码拷到 ARM 机器，装好编译器直接编：

```bash
[root@arm migration]# yum -y install gcc gcc-c++ make
[root@arm migration]# gcc test.c -o test_arm
```

跑起来一切正常。这条路的"成本"是你得有一台 ARM 机器——而在信创迁移的实际项目里，这通常不是问题（测试环境本来就有）。

## 路径二：交叉编译——装完编译器只是第一步

在 x86 的机器上装交叉编译器：

```bash
[root@x86 ~]# yum -y install gcc gcc-c++ make
# 32 位交叉编译
[root@x86 ~]# yum -y install gcc-arm-linux-gnu
# 64 位交叉编译
[root@x86 ~]# yum -y install gcc-aarch64-linux-gnu
```

装完了，看起来可以编了。试一下：

```bash
[root@x86 ~]# aarch64-linux-gnu-gcc test.c -o test_arm_by_x86
test.c:1:10: fatal error: stdio.h: No such file or directory
    1 | #include <stdio.h>
      |          ^~~~~~~~~
compilation terminated.
```

**报错不是"编译器没装好"，而是"缺目标平台的库文件"。**

这是交叉编译最容易误解的一点：`aarch64-linux-gnu-gcc` 只提供了**编译器本体**，它需要链接的 `stdio.h`、`libc` 等头文件和库，必须是对应 ARM 架构的版本——而你的 x86 系统上装的都是 x86 的库，编译器找不到 ARM 版的头文件，于是连第一行 `#include` 都过不去。

:::warn
看到 `stdio.h: No such file or directory` 时，不要去检查 `#include` 写错了没有。在交叉编译的场景下，这个报错 99% 是**目标平台的头文件/库没装**。
:::

## 用完整工具链解决

发行版自带的交叉编译包往往只给编译器。要真正能编，需要一个**自带 sysroot（目标平台根文件系统）的完整工具链**。Linaro 提供的 aarch64 工具链就是这类：

```bash
[root@x86 ~]# wget https://releases.linaro.org/components/toolchain/binaries/latest-7/aarch64-linux-gnu/gcc-linaro-7.5.0-2019.12-x86_64_aarch64-linux-gnu.tar.xz
[root@x86 ~]# tar -xf gcc-linaro-7.5.0-2019.12-x86_64_aarch64-linux-gnu.tar.xz -C /opt/
```

用完整路径调用它：

```bash
[root@x86 ~]# /opt/gcc-linaro-7.5.0-2019.12-x86_64_aarch64-linux-gnu/bin/aarch64-linux-gnu-gcc test.c -o test_arm_by_x86
```

这次**编译成功了**——没有报错就是最大的进展。

## 交叉编译的产物，在本机跑不了（这是对的）

编译成功之后，人容易顺手就想验证一下：

```bash
[root@x86 ~]# ./test_arm_by_x86
-bash: ./test_arm_by_x86: cannot execute binary file: Exec format error
```

**这个报错是正常的，不是失败。** 产物是 ARM 指令集的二进制，x86 内核当然执行不了。验证它必须拿到 ARM 机器上：

```bash
[root@x86 ~]# scp test_arm_by_x86 <arm-host>:/migration
[root@arm migration]# ./test_arm_by_x86
平台：ARM 架构
指针大小：8 字节
int 大小：4 字节
计算结果：10 + 20 = 30
```

跑通了。所以**交叉编译的验收必须在目标平台做**，在构建机上永远只能验"编译通过"，验不了"运行正常"。

:::note
如果确实想在 x86 上验证 ARM 二进制的行为，需要 QEMU 用户态模拟（`qemu-aarch64-static`）配合 `binfmt_misc`。这属于额外的工具链，不在基本流程里。
:::

## 鲲鹏专用编译器：GCC for openEuler

除了通用工具链，鲲鹏生态还提供了优化过的编译器。它的定位是：

> 基于开源 GCC 12.3 开发，针对**鲲鹏 920 处理器**做了深度优化，在 OpenMP、**SVE 向量化**、数学库等领域挖掘性能。默认使用场景就是鲲鹏 920 + ARM 架构。

安装方式是拿官方提供的压缩包解压直接用：

```bash
[root@arm ~]# mkdir -p /opt/aarch64/compiler
[root@arm ~]# cp -rf /root/pkgs/gcc-12.3.1-2025.12-aarch64-linux.tar.gz /opt/aarch64/compiler
[root@arm compiler]# tar -xf gcc-12.3.1-2025.12-aarch64-linux.tar.gz
```

它的 `-v` 输出里能直接看出和系统自带 gcc 的区别：

```text
# 系统自带
Target: aarch64-openEuler-linux
gcc version 12.3.1 (openEuler 12.3.1-105.oe2403sp3) (GCC)

# GCC for openEuler
Target: aarch64-linux-gnu
gcc version 12.3.1 (gcc for openEuler 3.0.5)
```

用它对同一份源码编译，产物一样能跑：

```bash
[root@arm migration]# /opt/aarch64/compiler/gcc-12.3.1-2025.12-aarch64-linux/bin/gcc test.c -o test_gcc_for_openeuler
[root@arm migration]# ./test_gcc_for_openeuler
平台：ARM 架构
```

**功能上没有差别，差别在性能。** 同一个 C 程序用哪个编译器都能编能跑，但需要跑满鲲鹏性能的业务（尤其是带向量化计算的），用优化过的编译器才有意义。

:::note
这个编译器**只在 ARM 平台自身可用**——它是给鲲鹏机器上的本地编译准备的，不是交叉编译器。别搞混了。
:::

## 三条路的取舍

| | 本地编译（ARM） | 交叉编译 | 专用编译器 |
|---|---|---|---|
| 需要 ARM 机器 | ✅ 必须 | ❌ 不需要 | ✅ 必须 |
| 环境复杂度 | 低 | **高**（工具链 + sysroot） | 低 |
| 验收 | 直接跑 | 必须传到目标机 | 直接跑 |
| 出问题好排查吗 | 容易 | 较难（构建机与运行机分离） | 容易 |

**实践建议**：能上 ARM 机器就在 ARM 上编，交叉编译留给"真的没有目标机"或者"CI 里要批量构建多架构产物"的场景。交叉编译的环境调试成本，往往比多开一台 ARM 虚拟机更高。

## 踩坑清单

| 现象 | 原因 | 处理 |
|---|---|---|
| `stdio.h: No such file or directory` | 只有编译器，缺目标平台头文件 | 用自带 sysroot 的完整工具链 |
| 交叉编译产物 `Exec format error` | 产物是目标架构的，构建机跑不了 | 属正常，传到目标机验证 |
| 交叉编译通过但目标机跑不起来 | 动态库版本/musl 与 glibc 不匹配 | 确认 sysroot 与目标系统一致 |
| 编译能过但不是给鲲鹏优化的 | 用了通用编译器 | 性能敏感场景换 GCC for openEuler |
| 把 GCC for openEuler 当交叉编译器用 | 它只支持 ARM 本地编译 | 交叉编译另找工具链 |

## 一句话总结

交叉编译的难点**不在"怎么编"，而在"把目标平台的库和头文件凑齐"**。判断自己是否真的需要它：如果手边有 ARM 机器，别折腾交叉编译。
