# 抽选数据之可爱的流星雨

一个支持在线飞书表格与本地文件读取的可视化抽样工具。

## 功能

- 支持读取在线飞书表格链接
- 支持上传 `CSV / XLSX / XLS`
- 支持选择工作表与单元格范围
- 按分类字段生成每类抽样数量
- 支持手动编辑每个类别的抽样条数
- 支持多选均衡字段与均衡值
- 在全部数据预览中高亮抽中的行
- 支持导出为 `CSV / XLSX / 飞书表格`

## 文件说明

- `index.html`：前端页面
- `app.py`：本地服务与导出接口
- `assets/`：页面素材

## 本地运行

确保本机已安装 Python 3。

```bash
python3 app.py
```

启动后访问：

```bash
http://127.0.0.1:8877/index.html
```

## 说明

当前版本为本地网页工具，依赖本地服务处理飞书读取与导出逻辑。

## Render 部署

仓库已包含：

- `requirements.txt`
- `render.yaml`

Render 连接 GitHub 仓库后可直接创建 Web Service 并使用：

```bash
python app.py
```

### 在线版默认可用

- 本地文件上传
- 预览与抽样
- 导出 `CSV / XLSX`

### 飞书在线读取 / 导出飞书表格

现在已经支持两种模式：

1. 优先使用飞书官方 OpenAPI
2. 如果没有配置官方 API，再回退到本地 `lark-cli`

线上部署建议直接使用官方 OpenAPI。在 Render 的环境变量里填写：

```text
FEISHU_APP_ID=你的飞书应用 App ID
FEISHU_APP_SECRET=你的飞书应用 App Secret
FEISHU_FOLDER_TOKEN=可选，导出到指定文件夹时再填
```

还需要在飞书开放平台为应用开通电子表格相关权限，并把应用添加到目标表格里，否则会报权限不足。

注意：

- 只配置了 `FEISHU_APP_ID / FEISHU_APP_SECRET`，还不代表自动有权访问所有表格
- 使用 `tenant_access_token` 时，应用本身也必须被加入目标表格，或者使用应用自己创建的表格
- 如果你本地已经登录了 `lark-cli`，未配置官方 API 时仍然可以继续本地使用旧链路
