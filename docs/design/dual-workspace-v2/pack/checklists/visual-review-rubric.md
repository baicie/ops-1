# UI 视觉/交互验收评分表（主观审查 + 可验证证据）

每项 0/1/2：0=未做或失败，1=部分/明显缺陷，2=达到目标。不要用一张截图给所有页面打满分。

| 维度 | 审查点 |
|---|---|
| 导航与布局 | 用户可在 1–2 次操作找到目标；选中、折叠、面包屑明确 |
| 视觉层次 | 一眼能辨认主 CTA、当前状态、最近变更、错误 |
| 排版与密度 | 标题/正文/辅助文字统一；中英文/数字不会挤压错位 |
| Token 一致性 | Primary/Border/Muted/Status 色来自单一语义系统 |
| 响应式 | 1440/1024/390 可用，移动端不是缩小桌面宽表 |
| 暗色 | 对比度、边界、Overlay/Sheet/Popover 全覆盖 |
| 加载与错误 | Skeleton、Empty、No Data、Stale、Forbidden 清楚 |
| 关键交互 | 搜索/筛选/排序/批量操作/详情/返回有效 |
| 键盘与读屏 | Tab、Esc、Focus 恢复、label、aria 与表格语义 |
| 用户可感知成果 | 和旧版同内容截图并排，说明具体改进，不仅一句“更高级” |

**图片命名**：`<sha>/<surface>/<route>/<viewport>-<theme>-<locale>-<state>.png`。截图必须来自真实浏览器，且和版本页返回的 SHA 一致；Pixel snapshot 只有真正建立 `toHaveScreenshot` 才可宣称。
