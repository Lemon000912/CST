/**
 * Semantic Scholar API 搜索模块
 * 提供免费的学术文献搜索API
 * https://api.semanticscholar.org/api-docs/
 */

const BASE_URL = "https://api.semanticscholar.org/graph/v1";

/**
 * 搜索Semantic Scholar
 * @param {string} query 搜索关键词
 * @param {number} max 最大结果数
 * @returns {Promise<Array>} 论文列表
 */
export async function fetchSemanticScholarWorks(query, max = 10) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  
  const limit = Math.min(35, Math.max(1, Number(max) || 10));
  const url = `${BASE_URL}/paper/search?query=${encodeURIComponent(q)}&limit=${limit}&fields=title,authors,year,abstract,doi,url,citationCount,referenceCount,fieldsOfStudy`;
  
  try {
    const r = await fetch(url, {
      headers: {
        "Accept": "application/json",
      },
    });
    
    if (!r.ok) {
      console.warn("[semantic_scholar] HTTP", r.status);
      return [];
    }
    
    const data = await r.json();
    const papers = data.data || [];
    
    return papers.map((p) => ({
      paper_id: `semanticscholar:${p.paperId}`,
      doi: p.doi || null,
      title: p.title || "",
      summary: p.abstract || "",
      abstract: p.abstract || "",
      year: p.year || null,
      venue: p.fieldsOfStudy?.[0] || "",
      published: p.year ? `${p.year}-01-01` : "",
      authors: p.authors?.map(a => a.name) || [],
      id: p.doi || p.paperId,
      absUrl: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
      pdfUrl: null,
      source: "semantic_scholar",
      oa_status: null,
      isReferencedByCount: p.citationCount || 0,
    }));
  } catch (e) {
    console.warn("[semantic_scholar] error", e?.message || e);
    return [];
  }
}

/**
 * 根据DOI获取论文详情
 * @param {string} doi 
 * @returns {Promise<Array>}
 */
export async function fetchSemanticScholarByDoi(doi) {
  const d = String(doi ?? "").trim();
  if (!d) return [];
  
  try {
    const url = `${BASE_URL}/paper/DOI:${encodeURIComponent(d)}?fields=title,authors,year,abstract,doi,url,citationCount,referenceCount`;
    const r = await fetch(url, {
      headers: { "Accept": "application/json" },
    });
    
    if (!r.ok) return [];
    
    const p = await r.json();
    if (!p.paperId) return [];
    
    return [{
      paper_id: `semanticscholar:${p.paperId}`,
      doi: p.doi || d,
      title: p.title || "",
      summary: p.abstract || "",
      abstract: p.abstract || "",
      year: p.year || null,
      venue: "",
      published: p.year ? `${p.year}-01-01` : "",
      authors: p.authors?.map(a => a.name) || [],
      id: p.doi || p.paperId,
      absUrl: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
      pdfUrl: null,
      source: "semantic_scholar",
      oa_status: null,
      isReferencedByCount: p.citationCount || 0,
    }];
  } catch (e) {
    console.warn("[semantic_scholar] doi fetch error", e?.message || e);
    return [];
  }
}
