# `plugin-lifecycle` 的 Maven 失败：复现记录与结论边界

**运行**：[run 44666711786](https://github.com/baicie/ops-1/actions/runs/44666711786)，
任务 `full TypeScript lifecycle`，main `f26ed77`。

**状态：`SUSPECTED_RISK` —— 根因未确定，修复未提交。**

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
