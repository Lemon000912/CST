# 前端API连接配置

## 后端服务信息

| 项目 | 值 |
|------|-----|
| **服务地址** | `http://127.0.0.1:9003` |
| **API 前缀** | `/api/v1` |
| **认证地址** | `/api/auth` |
| **文档地址** | `http://127.0.0.1:9003/docs` |

## 主要API端点

### 1. 搜索API

```typescript
// 智能搜索（数据库 + 网络）
POST http://127.0.0.1:9003/api/v1/search
Content-Type: application/json

{
  "query": "材料名称",
  "search_type": "all",  // "all" | "db" | "web"
  "top_k": 10,
  "user_id": "可选",
  "session_id": "可选"
}
```

### 2. 认证API

```typescript
// 登录
POST http://127.0.0.1:9003/api/auth/login
Content-Type: application/x-www-form-urlencoded

username=admin&password=admin123

// 注册
POST http://127.0.0.1:9003/api/auth/register
Content-Type: application/json

{
  "username": "新用户",
  "email": "user@example.com",
  "password": "密码"
}
```

### 3. 健康检查

```typescript
GET http://127.0.0.1:9003/api/health
```

## 前端代理配置

修改本仓库 `backend/index.js`（或你部署路径下的 `index.js`），添加以下内容：

```javascript
// 材料知识库后端API
const MATERIAL_KB_API = "http://127.0.0.1:9003";

// 代理搜索请求到材料知识库
app.post("/api/search/material", async (req, res) => {
  try {
    const { query, search_type = "all", top_k = 12 } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: "缺少检索关键词 query" });
    }

    const url = `${MATERIAL_KB_API}/api/v1/search`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        search_type,
        top_k,
      }),
    });

    if (!r.ok) {
      const error = await r.text();
      return res.status(502).json({ error: `知识库请求失败: ${r.status}`, details: error });
    }

    const data = await r.json();
    
    // 转换格式以兼容前端
    const papers = data.data?.results?.map((item) => ({
      id: item.id || String(Math.random()),
      title: item.title || "无标题",
      summary: item.abstract || item.content || "",
      published: item.published || "",
      authors: item.authors || [],
      pdfUrl: item.pdf_url || "",
      absUrl: item.url || "",
      source: item.source,
      score: item.score,
      materialName: item.material_name,
      category: item.category,
    })) || [];

    res.json({ 
      papers, 
      source: `material_kb_${data.data?.search_type || 'unknown'}`, 
      total: data.data?.total || 0,
      rewrittenQuery: data.data?.rewritten_query,
    });
  } catch (e) {
    console.error("材料知识库搜索错误:", e);
    res.status(500).json({ error: "服务器检索出错", details: e.message });
  }
});
```

## 前端调用示例

在 `E:\知识库\论文查询\src\api.ts` 中添加：

```typescript
// 搜索材料知识库
export async function searchMaterialKB(
  query: string,
  max = 12,
  searchType = "all"
): Promise<SearchResponse> {
  const res = await fetch("/api/search/material", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, top_k: max, search_type: searchType }),
  });
  const data = (await res.json()) as SearchResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}
```

## 默认账号

- **用户名**: `admin`
- **密码**: `admin123`
