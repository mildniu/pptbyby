# PPTByBy — AI 原生可编辑 PPT 生成平台

把 [ppt-master](https://github.com/hugohe3/ppt-master)（MIT）的 Agent 工作流蒸馏成网站服务：主题/材料进，**PowerPoint 原生可编辑** PPTX 出——原生形状、原生文本框、分组结构，不是贴图。

## 架构

```
web/      Vite + React 前端（创建任务 → 大纲确认 → 逐页 SVG 实时预览 → 下载）
server/   Fastify + SQLite
          ├── gateway.ts       OpenAI 兼容网关（chat 驱动大纲/逐页生成，images 生图）
          ├── orchestrator.ts  ppt-master 工作流的服务端蒸馏：
          │     Strategist:  一次 chat → 设计规格 + 大纲（用户网页确认）
          │     Executor:    逐页 chat → 项目规范 SVG → quality checker → 错误回喂修复
          │     Export:      finalize → svg_to_pptx（vendor 的确定性 Python 管线）
          └── credits.ts      积分：1 积分/页 + AI 配图 1 积分/张，预扣-结算-失败全退
pipeline/ vendor 的 ppt-master v6.1.0 skill（Python 脚本 + 规范文档，含 .venv）
```

## 快速开始

```bash
# 1. Python 管线依赖（一次性）
cd pipeline && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cd ..

# 2. Node 依赖
npm install

# 3. 启动（开发）
npm run dev:server   # 端口 3400
npm run dev:web      # 端口 5175，代理到 3400

# 生产（pm2）
pm2 start ecosystem.config.json
```

登录后在「网关设置」配置 OpenAI 兼容网关（Base URL / API Key / chat 模型 / 生图模型）。
chat 模型建议大上下文、强推理模型（上游推荐 Kimi K3 / Claude 级别，模型决定成稿上限）。

## 任务模式

| 模式 | 状态 | 说明 |
|---|---|---|
| 生成 PPT | ✅ | 主题/材料 → 确认大纲 → 逐页生成 |
| 快速生成 | ✅ | 跳过确认，一步直出 |
| 美化 PPT | 🚧 | 保持页数/顺序/措辞重排视觉 |
| 编辑 PPT | 🚧 | 上传 PPTX，保留原设计改内容（roundtrip） |
| 创建模板 | 🚧 | 蒸馏品牌/风格/版式模板 |
| 图片转 PPT | 🚧 | 页面截图重建可编辑 |

## 积分规则

- **1 积分 / 页**（按大纲页数预扣，完成按实际产出页结算，多退少补）
- **AI 配图 1 积分 / 张**（图片生成失败不扣）
- 任务失败 / 取消：未结算预扣全额退还

## Credits

- 生成管线 vendor 自 [hugohe3/ppt-master](https://github.com/hugohe3/ppt-master) v6.1.0（MIT License，版权归 Hugo He 所有，见 `pipeline/LICENSE`）
- 本项目其余部分 MIT
