# CompShare MiniMax H3 for Codex

在 Codex 中控制 CompShare MiniMax H3 视频任务：预估积分、创建、查询、等待、列出任务、查看余额和套餐、取消以及下载结果。

## 配置

1. 在 [CompShare 视频工作台](https://console.compshare.cn/modelverse/video) 的 API 窗口创建一个以 `sk-ml-` 开头的模型 API Key。
2. 在克隆的 Marketplace 仓库中运行：

   ```powershell
   & ".\plugins\compshare-minimax-h3\scripts\configure-key.ps1"
   ```

   脚本会安全提示输入，不会把 Key 写进命令历史或插件文件。Key 会保存为当前 Windows 用户的 `COMPSHARE_MINIMAX_API_KEY` 环境变量。
3. 完全退出并重新打开 Codex，再新建一个任务。

可选：设置 `COMPSHARE_MINIMAX_OUTPUT_DIR` 来改变默认下载目录；默认目录是 `%USERPROFILE%\Videos\MiniMax-H3`。

## 使用示例

- “查询我的 MiniMax H3 积分余额。”
- “先估算生成一条 5 秒、1080P、9:16 视频需要多少积分。”
- “用提示词……生成 5 秒 768P 竖屏视频；提交前告诉我预计积分。”
- “等待任务 `<task_id>` 完成并下载到 `D:\Videos`。”
- “查看最近 20 个失败任务。”
- “取消任务 `<task_id>`。”

## 重要限制

- CompShare 接口接收的是公网可访问的图片、视频和音频 URL；本机文件路径不能直接作为生成素材。
- 创建任务会消耗积分。`create_video` 只有在 `confirm_spend=true` 时才提交。
- 1080P 和 2K 是后置超分档位；超分失败时，平台可能交付 768P 并释放超分加价积分。
- 计费与参数以 [CompShare 官方 MiniMax H3 API 文档](https://www.compshare.cn/docs/modelverse/models/video_api/minimax-h3-video-api) 为准。

## 安全设计

- API Key 只从 `COMPSHARE_MINIMAX_API_KEY` 环境变量读取，不出现在插件文件、请求结果或日志中。
- 下载视频时不会把 API Key 发送给视频下载 URL。
- API 基础地址固定为 `https://cp.compshare.cn`，避免凭证被自定义地址截获。
