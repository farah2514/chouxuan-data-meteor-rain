# 综合网页工具

这个项目现在包含两个模块：

- `图片拼图`：支持上传图片、链接提图、TikTok 增强提图、拖拽排序、PNG 拼图、GIF 动图预览与下载
- `分类抽样`：支持表格抽样、导出和基础在线处理

## 本地运行

确保本机安装了 Node.js 和 Python 3，然后在项目根目录执行：

```bash
npm install
pip install -r sampler/requirements.txt
npm start
```

启动后打开：

```text
http://localhost:3000
```

## Docker 部署

项目根目录已经包含：

- `Dockerfile`
- `.dockerignore`
- `render.yaml`

可以直接部署到支持 Docker 的平台，比如 Render、Railway、Fly.io 等。

### Render

1. 在 Render 新建 `Web Service`
2. 连接这个 GitHub 仓库
3. 选择 `Docker` 方式部署
4. 平台会自动读取根目录的 `Dockerfile`

健康检查地址可以填：

```text
/healthz
```

## 线上说明

- 线上部署会保留普通提图、TikTok 增强提图、拼图、GIF、分类抽样等主要功能
- `辅助提图` 依赖本地可见浏览器窗口，云端环境默认关闭；本地运行时仍可继续使用
- 某些需要登录、强地区限制或强反爬的页面，线上与本地都可能提取失败
