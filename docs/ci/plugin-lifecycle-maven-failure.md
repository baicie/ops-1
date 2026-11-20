# `plugin-lifecycle` 的 Maven 失败：复现记录与结论边界

**运行**：[run 44666711786](https://github.com/baicie/ops-1/actions/runs/44666711786)，
任务 `full TypeScript lifecycle`，main `f26ed77`。

**状态：`INFRASTRUCTURE_FAILURE`（瞬时）—— 已由真实 runner 上的 `-X` 运行排除环境因素，
不需要代码修复。**

> **2026-11-20 更新。** 下面的第 1–7 节是**诊断之前**的记录，保留原样因为它们准确描述了当时
> 的证据边界。结论在第 8 节。

---

## 1. 已确认的事实

| # | 事实 | 证据 |
|---|---|---|
| 1 | 失败发生在 `scripts/build-plugins.sh` 构建 Java 插件时 | 日志：`JRE source: jlink:x64:java.se` 之后立刻 FATAL |
| 2 | 报错是 `Non-resolvable parent POM ... spring-boot-starter-parent:pom:3.3.5` | 日志 `[FATAL]` 行 |
| 3 | **该版本确实存在于 Central** | `curl` 三次全部 HTTP 200（6.8 s / 19.0 s / 14.6 s） |
| 4 | **CI 日志里没有任何 `Downloading from central` 行** | `grep -c` = 0 |
| 5 | Java 工具链本身正常 | jlink 成功产出了 JRE，失败只在 Maven 阶段 |

## 2. 事实 4 是关键，但它指向两个方向

Maven 在尝试下载时会打印 `Downloading from central: <url>`。这个字符串**一次都没出现**，
意味着两种可能：

- **A**：Maven 从未尝试联网，直接判定「找不到」——本地仓库里有失败标记，或仓库 id 不匹配
- **B**：它尝试了，但 `-q`（静默模式）把 `Downloading` 行连同其它 INFO 一起吞掉了

`scripts/build-plugins.sh:180` 用的是 `mvn -q`。**所以 B 无法排除，而 B 会让事实 4 失去意义。**

我在 PR 描述里如果写「Maven 一次都没尝试下载」，那是**把 B 当成了不存在**。不写。

## 3. 本地复现的尝试，以及它为什么不算数

用冷缓存目录（`-Dmaven.repo.local=/tmp/m2probe`）在本机跑同一条命令：

```
[INFO] Downloading from central: .../spring-boot-starter-parent-3.3.5.pom
[FATAL] ... Connect to repo.maven.apache.org:443 [198.18.0.55] failed: Read timed out
```

**这看起来像「超时」，但它证明不了 CI 的情况**：`198.18.0.55` 是我本机的代理地址，
不是 GitHub runner 的网络路径。而且加大 Maven 超时（`maven.wagon.http.*` 与
`aether.connector.*` 各试一次）**仍然失败**——同一个 TLS 断点，与超时长度无关。

所以本机证据能说明的只有一件事：**在这条网络路径上会超时**。它不能说明 CI runner 的路径。

## 4. 我试过但没有提交的修复

改 `scripts/build-plugins.sh`：加 `-Dmaven.wagon.http.connectionTimeout=60000`、
`readTimeout=180000`、`retryHandler.count=3`，并把 `-q` 换成 `-B`。

**没有提交，因为它在本地没有修复失败**。第一次用 wagon 属性，失败；改用 aether 属性，
仍然失败。一个没能在自己的复现环境里改变结果的补丁，提交它就是把这个文件变成一个
「看起来修好了」的地方——这比留着一个诚实的失败更糟。

已 `git checkout --` 撤回。

## 5. 要确定根因，需要什么

一条能区分 A 和 B 的命令，跑在**真实 runner 上**：

```bash
mvn -B -X -f plugins/hello-java/pom.xml -DskipTests package 2>&1 | grep -E \
  'Downloading from|Could not transfer|Connect to|Non-resolvable' | head -20
```

- 有 `Downloading from` + `Could not transfer` → 网络/超时，属 `INFRASTRUCTURE_FAILURE`
- 只有 `Non-resolvable`、没有任何 `Downloading` → 本地仓库负缓存或仓库配置，
  属 `CONFIGURATION_FAILURE`，需要看 runner 上的 `~/.m2/settings.xml` 与
  `~/.m2/repository/**/_remote.repositories`

这需要一次带调试输出的运行。**本轮没有执行**，因为那要改 workflow 并消耗一次 CI，
而三个 P0 PR 正在队列里。

## 6. 分类（按本仓库既定词汇）

| 维度 | 判定 |
|---|---|
| 是否确定性代码缺陷 | **否**——`pom.xml` 正确，版本存在，jlink 成功 |
| 是否 flaky | **未知**——只观测到一次，且日志被 `-q` 削弱 |
| 分类 | **`SUSPECTED_RISK`**，候选 `INFRASTRUCTURE_FAILURE` 或 `CONFIGURATION_FAILURE` |
| 修复 | **未提交** |

**不得**把它写成「网络抖动」了事，也不得写成「已修复」。它现在是一个**需要一次带 `-X`
的运行才能定性**的失败。

## 7. 与并发改动的关系

无关。`plugin-lifecycle.yml` 的 `concurrency` 改动只影响**多个 run 之间**的排队与取消，
不影响单个 run 内部的 Maven 行为。这次失败发生在唯一一个正在运行的 run 里。


---

# 8. 诊断运行的结果（决定性）

**运行**：workflow `maven-diagnosis.yml`，run `44674095884`，job `136081683625`，
分支 main `6d8579f`，`completed/success`。

## 8.1 环境与失败那次**完全相同**

| 项 | 值 |
|---|---|
| Runner | `ubuntu-24.04`（与 `plugin-lifecycle.yml:148` 相同） |
| 工具链装配顺序 | `setup-java` → `apt-get install maven`（与失败那次相同） |
| `which -a mvn` | `/usr/bin/mvn` → `/etc/alternatives/mvn` → `/usr/share/maven/bin/mvn` |
| `mvn -v` | **Apache Maven 3.8.7** |
| JDK | 21.0.13，Eclipse Adoptium，`/usr/lib/jvm/temurin-21-jdk-amd64` |
| `JAVA_HOME` | `/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/21.0.13-9/x64` |

**Maven 3.8.7 就是 CI 实际用的版本**——不是我在第 3 节猜的「Maven 版本差异」。

## 8.2 网络：正常，而且很快

```
attempt 1: http=200 connect=0.047s ttfb=0.086s total=0.086s
attempt 2: http=200 connect=0.006s ttfb=0.044s total=0.044s
attempt 3: http=200 connect=0.006s ttfb=0.044s total=0.044s
```

**43–86 毫秒**，不是我在本机测到的 6.8–19 秒。**「超时」这个假设被证伪。**

## 8.3 Maven 确实下载了，而且成功了

```
[INFO] Downloading from central: .../spring-boot-starter-parent-3.3.5.pom
[INFO] Downloaded from central: ... (13 kB at 23 kB/s)
[INFO] Downloading from central: .../spring-boot-dependencies-3.3.5.pom
[INFO] Downloaded from central: ... (100 kB at 1.9 MB/s)
...
-rw-r--r-- 1 runner runner 20058377 ... hello-java-0.0.1.jar
```

冷本地仓库（`-Dmaven.repo.local=/tmp/m2-diag`）、`-X`、同一条命令——**构建成功，产出 20 MB 的 jar**。

## 8.4 结论

| 维度 | 判定 |
|---|---|
| pom 或版本错误 | **否**——`3.3.5` 存在且能解析 |
| Maven 版本问题 | **否**——同一个 3.8.7 成功 |
| 工具链/JDK 问题 | **否**——同一个 JDK 成功 |
| 持续性网络问题 | **否**——同一条路径 43–86 ms |
| 仓库配置/mirror | **否**——`setup-java` 写的 `~/.m2/settings.xml` 无害 |
| **分类** | **`INFRASTRUCTURE_FAILURE`（瞬时）** |

失败的那次（`44666711786`）是一次**不可复现的瞬时故障**。同环境同命令在同一天成功。

**不提交代码修复**：没有可修的确定性缺陷。改 `build-plugins.sh` 只会是在一个健康路径上加
无用的重试逻辑。

## 8.5 我之前的哪些判断是错的

诚实地记下来，因为这些错误方法本身值得警惕：

| 我写过的 | 实际情况 |
|---|---|
| 「本机复现出 TLS 超时，看起来像网络」 | 我的本机走 `198.18.0.55` 代理，**与 runner 无关**。runner 是 43 ms |
| 「加大 Maven 超时是修复方向」 | 方向完全错了——网络没问题，超时不会发生 |
| 「CI 日志零 `Downloading` 行说明 Maven 可能没试」 | 这个不确定性是真实的，但**解决它不需要推理，只需要一次 `-X` 运行** |
| （隐含）「没有 settings.xml」 | **错**。`setup-java` 会写 `~/.m2/settings.xml` 和 `toolchains.xml` |

## 8.6 唯一值得保留的改进

`scripts/build-plugins.sh` 用 `mvn -q`。正是它让这次失败**看起来像「版本不存在」**，
把一次可自证的瞬时故障变成了需要专门诊断运行才能解释的谜。

把 `-q` 换成 `-B` 不会让失败消失，但会让**下一次**失败自己说明原因。这不是修复，
是可观测性改进——值得单独提，但不适用于掩盖本次结论。
