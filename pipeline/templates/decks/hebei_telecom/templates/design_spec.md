---
deck_id: hebei_telecom
kind: deck
category: brand
summary: 中国电信省市公司年中/年终工作会议、经营形势分析与重点工作部署汇报，采用白底、正红标题条、多网格卡片与清晰层级的严谨国企风格。
keywords: [中国电信, 河北电信, 工作会议, 经营分析, 国企汇报, 重点工作清单]
primary_color: "#C00000"
canvas_format: ppt169
canvas_width: 1280
canvas_height: 720
canvas_viewbox: "0 0 1280 720"
source_canvas_width: 1280
source_canvas_height: 720
source_viewbox: "0 0 1280 720"
replication_mode: standard
native_structure_mode: structured
page_count: 7
---

# 河北电信经营分析与工作部署 — Design Specification

## I. Template Overview

| Application context | Definition |
| --- | --- |
| Recurring presentation family | 省市分公司年中/年终工作会议、经营形势研判、十五五规划愿景宣贯、下阶段工作清单部署 |
| Intended audiences and outcomes | 面向省市公司领导班子、各部门与区县一把手；用于统一思想、研判经营得失、明确指标目标并分解重点工作任务 |
| Delivery and reading assumptions | 会议现场投影讲解与会后下发执行；排版信息承载量大，卡片结构清晰，关键论点与数据一目了然 |
| Representative narrative/page roles | 覆盖会议主封面、3章节目录、8网格经营回顾看板、3阶段阶梯演进图、愿景目标与指标矩阵、4列工作安排矩阵、结语宣誓页 |

## II. Color Scheme

| Role | Color | Application |
| --- | --- | --- |
| Telecom Red | #C00000 | 页面主标题、卡片红顶条、核心数据数字、重点强调 |
| Deep Red | #991B1B | 警告与警示卡片、醒目标签 |
| Dark Neutral | #111827 | 正文大标题、核心结论文本 |
| Body Text | #374151 | 卡片内详细工作要点、列表说明 |
| Subtitle Gray | #6B7280 | 辅助说明、副标题、数据来源 |
| Panel Background | #F8FAFC | 卡片内容背景区 |
| Border Gray | #E2E8F0 | 卡片边框与内部分隔线 |
| Pure White | #FFFFFF | 页面主底色与反白文字 |

## III. Typography

| Role | Font stack | Application |
| --- | --- | --- |
| Chinese title and body | "Microsoft YaHei", "PingFang SC", Arial, sans-serif | 主标题、副标题、卡片标题与正文清单 |
| Latin & numbers | "Microsoft YaHei", "PingFang SC", Arial, sans-serif | 统计数字、百分比、年份（2026/2030）与页码 |

## IV. Page Roster

| File | Master | Layout key | Visual character | Reusable slots |
| --- | --- | --- | --- | --- |
| `01_cover.svg` | Hebei Telecom Brand Master | cover | 居中大主副标题、顶部电信Logo与5G标、底部城市飘带 | 主标题、副标题、会议类型 |
| `02_toc.svg` | Hebei Telecom Content Master | agenda | 顶部红字标题、左侧菱形回顾标签、右侧三行胶囊编号清单 | 页面标题、3个章节项、页码 |
| `03_review_board.svg` | Hebei Telecom Content Master | dashboard_8grid | 顶部营收进度总览横幅、下方 2×4 八宫格红顶卡片 | 8个业务维度回顾卡片、页码 |
| `04_evolution_path.svg` | Hebei Telecom Content Master | step_evolution | 顶部核心研判结论、下方3阶段阶梯上升推进卡片 | 2024/2025/2026演进路径、页码 |
| `05_vision_metrics.svg` | Hebei Telecom Content Master | vision_target | 顶部规划总纲、中间3大核心指标卡、底部3大愿景目标 | 核心指标、愿景支柱、页码 |
| `06_action_matrix.svg` | Hebei Telecom Content Master | action_grid | 顶部工作总要求、下方 4 大板块能力矩阵卡片清单 | 4大能力领域、工作清单、页码 |
| `07_closing.svg` | Hebei Telecom Brand Master | closing | 居中16字企业精神大字、左下角作风三行、底部红飘带 | 口号标语、精神宣贯、页码 |

## V. Assets

| File | Intended usage |
| --- | --- |
| logo.png | 顶部左侧中国电信标准 Logo |
| footer_ribbon.png | 封面与结束页底部红色波浪装饰条 |
| skyline_bg.png | 封面右下角科技城市线稿 |
| slogan_red.png | 备用红底品牌宣传标语 |
