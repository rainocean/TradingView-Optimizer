# TradingView Optimizer

`tradingview optimizer.js` 是一个 TradingView Tampermonkey 用户脚本，用于整合常用的图表页辅助功能，减少重复操作和付费弹窗干扰。

## 功能概览

- **Watchlist 批量添加**
  - 从当前 TradingView watchlist 页面提取 symbol。
  - 支持手动粘贴 A 股代码。
  - 自动为 A 股代码匹配 `SSE:` 或 `SZSE:` 前缀。
  - 支持预览匹配结果后，再手动点击开始添加。
  - 添加过程中支持暂停、跳过、复制当前、复制全部。

- **A 股代码格式识别**
  - 支持纯 6 位代码，例如 `600519`、`300750`。
  - 支持带市场后缀格式，例如 `600519.SH`、`300750.SZ`。
  - 支持部分已有前缀格式，例如 `SH:600519`、`SZ:300750`、`XSHG:600519`、`XSHE:300750`。

- **TradingView 快捷键增加**
  - `Alt + S`：打开 Symbol Search。
  - `Alt + C`：打开 Compare Symbols。
  - 输入框、文本域、可编辑区域内不会触发快捷键。

- **Pine Log 复制**
  - 在 TradingView 图表页的 Pine Log 面板附近添加复制按钮。
  - 自动收集虚拟滚动列表中的日志内容并复制到剪贴板。

- **付费弹窗处理**
  - 自动隐藏/移除 TradingView 的付费升级弹窗。
  - 点击付费入口时显示简短 Toast 提示，避免弹窗打断操作。

## 使用方式

1. 将 `tradingview optimizer.js` 安装到 Tampermonkey。
2. 打开 TradingView 页面。
3. 在图表页右侧找到悬浮图标按钮。
4. 点击按钮打开 TVO 面板。
5. 根据需要使用 watchlist 批量添加、A 股代码匹配、复制功能或快捷键。

## 运行范围

脚本匹配以下 TradingView 页面：

```js
*://*.tradingview.com/*
*://tradingview.com/*
```

部分功能只在图表页或 watchlist 相关页面启用。
