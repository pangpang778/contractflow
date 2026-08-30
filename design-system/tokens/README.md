# Design Tokens（设计令牌）

机器可读优先（JSON）。内部工作台以信息密度与状态清晰为首：不做花哨动效，但数字必须可读、状态必须可辨。

## 颜色 tokens.json
```json
{
  "color": {
    "bg": { "app": "#f5f6f8", "surface": "#ffffff", "inset": "#eef0f3" },
    "text": { "primary": "#1a1d21", "secondary": "#5b6470", "muted": "#8a94a1" },
    "border": { "default": "#d8dce1", "strong": "#b8bfc7" },
    "amount": { "positive": "#0a7d3e", "negative": "#c62828", "neutral": "#1a1d21" },
    "status": {
      "draft": "#8a94a1", "in_review": "#b26a00", "pending_sign": "#3f51b5",
      "active": "#0a7d3e", "amended": "#6a5acd", "settled": "#00695c", "archived": "#37474f", "void": "#c62828"
    }
  }
}
```

## 字号 tokens.json
```json
{
  "type": {
    "scale": { "xs": "12px", "sm": "13px", "base": "14px", "lg": "16px", "xl": "20px", "display": "26px" },
    "weights": { "regular": 400, "medium": 500, "semibold": 600 },
    "mono": "ui-monospace, SFMono-Regular, Menlo, monospace"
  }
}
```

## 间距 / 圆角 tokens.json
```json
{
  "space": { "xs": "4px", "sm": "8px", "md": "12px", "lg": "16px", "xl": "24px", "xxl": "32px" },
  "radius": { "sm": "4px", "md": "6px", "lg": "10px" }
}
```

## 使用约定
- 金额数字一律用 `mono` 字体 + 字重 `medium`，前导小数按元展示但值域永远整数"分"。
- 状态颜色只取自 `color.status`，代码里不硬编码其它色值。
- 数字旺的表格字号用 `base`/`sm`，标题用 `lg`/`xl`；对比度最低满足 WCAG AA。

## 令牌落地
- 前端为 vanilla（无构建），令牌以 `design-system/tokens/*.json` 为单一事实源，`scripts/gen-css.js`（待建）将其导出为 `:root{}` CSS 变量供 `<link>` 引用。
- 新增令牌先改 JSON，再重新生成 CSS；禁止手写进 CSS 造成双源漂移。