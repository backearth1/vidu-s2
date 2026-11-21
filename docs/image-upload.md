# 图片上传
通过此方法作为数字人图片传入，可以极大节省创建数字人的时间，**图片在90天后会被自动删除。**
### 接口总览

| 方法 | HTTP 请求 | 说明 |
| --- | --- | --- |
| Create | POST /live/v1/avatars | 创建数字人设资产 |
| Get | GET /live/v1/avatars/{id} | 查询单个数字人设资产 |
| Delete | DELETE /live/v1/avatars/{id} | 删除数字人设资产 |
| List | GET /live/v1/avatars | 分页列表查询 |

### 创建数字人设资产

**请求示例**```bash
curl -X POST "https://api.vidu.cn/live/v1/avatars" \
  -H "Authorization: Token vda_xxx" \
  -H "Content-Type: application/json" \
  -d '{"image_uri": "https://example.com/avatar.png", "name": "我的形象"}'
```**请求参数**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| image_uri | string | 人设形象图片，支持公网 URL 和 base64形式，仅支持 1 张【单人】图片，支持全身 / 半身、各种风格。格式：PNG / JPG / JPEG / WEBP；图片大小 ≤ 50MB；base64 decode 后字节长度 < 20M，且需包含内容类型前缀，例如 `data:image/png;base64,{base64_encode}` |
| name | string | 可选展示名，不传为空 |

**响应参数**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 数字人设资产 ID（可以作为`avatar.id`传入） |
| image_uri | string | 形象图片的访问地址 |
| name | string | 展示名 |
| status | string | 描述生成状态，取值见下方「status 枚举」 |
| created_at | timestamp | 创建时间 |
| updated_at | timestamp | 更新时间 |

**status 枚举**

| 值 | 含义 |
| --- | --- |
| created（1） | 已创建，等待生成描述 |
| processing（6） | 生成描述中 |
| success（11） | 生成成功 |
| failed（12） | 生成失败（终态，需重新创建） |

### 查询数字人设资产```bash
curl "https://api.vidu.cn/live/v1/avatars/{id}" \
  -H "Authorization: Token vda_xxx"
```### 删除数字人设资产```bash
curl -X DELETE "https://api.vidu.cn/live/v1/avatars/{id}" \
  -H "Authorization: Token vda_xxx"
```### 列表查询```bash
curl "https://api.vidu.cn/live/v1/avatars?pager.page=0&pager.pagesz=10" \
  -H "Authorization: Token vda_xxx"
```| Query 参数 | 类型 | 说明 |
| --- | --- | --- |
| pager.page | integer | 页码，从 0 开始，默认 0 |
| pager.pagesz | integer | 每页数量，默认 10，最大 100 |