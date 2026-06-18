---
name: wsl-electron-crash-forensics-without-core
description: "WSL2 上 Electron/原生程序崩溃,即便 coredump 被删,也能从 dmesg 寄存器 dump 复原崩溃指纹;附 ip==fault==小地址 的判读法与 WSL core 路由位置"
metadata: 
  node_type: memory
  type: reference
  originSessionId: b7e2d7ec-c877-4050-8f7e-d41de7a8dee8
---

WSL2 下进程(尤其 Electron/Chromium、原生模块程序)崩溃后,**即使 coredump 已被删**,仍有多条途径复原崩溃指纹,不必从头复现:

**1. dmesg 环形缓冲区(最可靠)**——内核为每次 userspace fatal signal 打印完整块:
```
dmesg | grep -iE "segfault|trap int3|fatal signal|CaptureCrash"        # 先定位
dmesg | awk '/segfault at <addr>/{f=1} f{print; n++} n>30{exit}'        # 拉完整寄存器/Code 块
```
块里含 `RIP / RSP / 各通用寄存器 / Code(故障处机器码)/ Comm / PID`。

**2. 指纹判读**:
- `ip == 故障地址 == 一个很小的地址`(如 `RIP:0xa330`,`Code: Unable to access opcode bytes`)→ **通过野/空指针跳转**;若该地址 ≈ `RDI 指向对象的 vtable基址(≈0) + 方法偏移`,即 **C++ 对已 free / vtable 被清零的对象发虚函数调用(use-after-free / 空 vtable)**。`RDI` 是 SysV 第一参数,常是 `this`。
- `Code` 字节里 `0f 0b` = **UD2**,是 V8/Chromium `CHECK`/`IMMEDIATE_CRASH()` 主动 abort(报 SIGTRAP/int3)。`cc` = int3。
- `RSP` 在 `0x7ffc…` 段 = 主线程栈;非主线程栈通常 mmap 在更低段(`0x76…`/`0x7b…`)。
- 据此可区分「Chromium 原生层崩」vs「应用 JS / 原生模块崩」,无需符号栈即可定大方向。

**3. WSL CaptureCrash 把 core 路由到 Windows 侧**:`/proc/sys/kernel/core_pattern` 为 `|/wsl-capture-crash …`;转储常落在 `\\…\Temp\wsl-crashes\`(WSL 配置)。注意**目录 mtime 更新但为空 = 文件曾存在后被删**(删除会更新父目录 mtime)。

**4. 时间戳坑**:WSL2 的 dmesg 单调时钟与墙钟会漂(曾见 dmesg 时间比当前 uptime 还大 ~2.7h),`dmesg -T` 同样不可信。**别用内核时间换算真实时间**,改用稳定锚点(如应用 userData 文件 mtime)。

**5. 隔离判原生模块**:用目标 Electron 自带 Node 跑切片,ABI 完全一致:`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron probe.js`(注意 WSLENV 泄漏的 `ELECTRON_RUN_AS_NODE` 见 [[wsl-electron-run-as-node-leak]];起 GUI 复现时要先 `unset`)。segfault 不抛异常只杀进程,探针按段 `fs.writeSync(1,...)` 打标记,**最后打印的标记即崩点**。
