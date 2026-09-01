# CompShare MiniMax H3 Codex Marketplace

这是一个供伙伴测试的私有 Codex 插件 Marketplace，内含 `compshare-minimax-h3` 插件。

## 安装

1. 获得此私有仓库的 GitHub 访问权限。
2. 在终端添加 Marketplace：

   ```powershell
   codex plugin marketplace add philchenzhaoqiang-hue/compshare-minimax-h3-marketplace --ref main
   ```

3. 在 Codex 的 Plugins 页面安装 **CompShare MiniMax H3**，或运行：

   ```powershell
   codex plugin add compshare-minimax-h3@compshare-minimax-h3-marketplace
   ```

4. 克隆仓库后，运行安全配置脚本并输入你自己的 CompShare 模型 API Key：

   ```powershell
   & ".\plugins\compshare-minimax-h3\scripts\configure-key.ps1"
   ```

5. 完全退出并重新打开 Codex，然后新建一个任务。

## 使用示例

- 查询我的 MiniMax H3 积分余额。
- 估算生成一条 5 秒 1080P 视频需要多少积分。
- 查看最近的 MiniMax H3 视频任务。
- 从腾讯云 COS 文件夹批量整理 MiniMax 可用的公网图片链接。

## 安全说明

- 仓库不包含 API Key、腾讯云密钥或用户数据。
- 每位测试者应使用自己的 `COMPSHARE_MINIMAX_API_KEY`。
- API Key 只保存在当前 Windows 用户环境变量中，不会写入插件文件。
- 创建视频任务会消耗测试者自己的 CompShare 积分。
