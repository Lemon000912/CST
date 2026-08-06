/**
 * GStack - 基于图的结果排序和融合算法
 * 
 * 核心思想：
 * 1. 将搜索结果构建为图节点
 * 2. 基于相似度、引用关系、共现关系建立边
 * 3. 使用图算法（PageRank、社区发现）进行排序
 * 4. 多源结果融合时考虑图结构信息
 */

import { createHash } from "crypto";

/**
 * 图节点 - 代表一篇文献
 */
class GraphNode {
  constructor(paper) {
    this.id = paper.id || paper.doi || this._generateId(paper);
    this.paper = paper;
    this.edges = new Map(); // nodeId -> edgeWeight
    this.pagerank = 1.0;
    this.community = null;
    this.source = paper.source || "unknown"; // database, web, pdf
  }

  _generateId(paper) {
    const str = `${paper.title}-${paper.authors?.join?.(",") || ""}`;
    return createHash("md5").update(str).digest("hex").slice(0, 16);
  }

  addEdge(nodeId, weight) {
    const current = this.edges.get(nodeId) || 0;
    this.edges.set(nodeId, Math.max(current, weight));
  }
}

/**
 * GStack 图融合引擎
 */
export class GStack {
  constructor(options = {}) {
    this.options = {
      similarityThreshold: options.similarityThreshold || 0.6,
      dampingFactor: options.dampingFactor || 0.85,
      maxIterations: options.maxIterations || 100,
      convergenceThreshold: options.convergenceThreshold || 0.0001,
      sourceWeights: options.sourceWeights || {
        database: 1.0,
        pdf_library: 0.95,
        web: 0.7,
        arxiv: 0.8,
        crossref: 0.85,
        openalex: 0.85,
        scopus: 0.9,
      },
      ...options,
    };
    this.nodes = new Map();
    this.query = "";
  }

  /**
   * 计算两篇文献的相似度（用于建边）
   */
  _calculateSimilarity(paper1, paper2) {
    let score = 0;
    let factors = 0;

    // 1. 标题相似度（Jaccard）
    if (paper1.title && paper2.title) {
      score += this._jaccardSimilarity(paper1.title, paper2.title) * 0.3;
      factors += 0.3;
    }

    // 2. 摘要相似度
    if (paper1.abstract && paper2.abstract) {
      score += this._jaccardSimilarity(paper1.abstract, paper2.abstract) * 0.25;
      factors += 0.25;
    }

    // 3. 作者重叠
    if (paper1.authors?.length && paper2.authors?.length) {
      const overlap = this._authorOverlap(paper1.authors, paper2.authors);
      score += overlap * 0.2;
      factors += 0.2;
    }

    // 4. 关键词重叠
    if (paper1.keywords?.length && paper2.keywords?.length) {
      const overlap = this._setOverlap(paper1.keywords, paper2.keywords);
      score += overlap * 0.15;
      factors += 0.15;
    }

    // 5. 年份接近度
    if (paper1.year && paper2.year) {
      const yearDiff = Math.abs(paper1.year - paper2.year);
      const yearSim = Math.max(0, 1 - yearDiff / 10);
      score += yearSim * 0.1;
      factors += 0.1;
    }

    return factors > 0 ? score / factors : 0;
  }

  /**
   * Jaccard相似度
   */
  _jaccardSimilarity(str1, str2) {
    const set1 = new Set(this._tokenize(str1));
    const set2 = new Set(this._tokenize(str2));
    const intersection = new Set([...set1].filter((x) => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * 分词
   */
  _tokenize(text) {
    if (!text) return [];
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
  }

  /**
   * 作者重叠度
   */
  _authorOverlap(authors1, authors2) {
    const set1 = new Set(authors1.map((a) => a.toLowerCase().trim()));
    const set2 = new Set(authors2.map((a) => a.toLowerCase().trim()));
    const intersection = new Set([...set1].filter((x) => set2.has(x)));
    return set1.size > 0 || set2.size > 0
      ? intersection.size / Math.max(set1.size, set2.size)
      : 0;
  }

  /**
   * 集合重叠度
   */
  _setOverlap(arr1, arr2) {
    const set1 = new Set(arr1.map((x) => String(x).toLowerCase()));
    const set2 = new Set(arr2.map((x) => String(x).toLowerCase()));
    const intersection = new Set([...set1].filter((x) => set2.has(x)));
    return set1.size > 0 || set2.size > 0
      ? intersection.size / Math.max(set1.size, set2.size)
      : 0;
  }

  /**
   * 构建图
   */
  _buildGraph(papers) {
    this.nodes.clear();

    // 创建节点
    for (const paper of papers) {
      const node = new GraphNode(paper);
      this.nodes.set(node.id, node);
    }

    // 建立边（基于相似度）
    const nodeList = Array.from(this.nodes.values());
    for (let i = 0; i < nodeList.length; i++) {
      for (let j = i + 1; j < nodeList.length; j++) {
        const similarity = this._calculateSimilarity(
          nodeList[i].paper,
          nodeList[j].paper
        );

        if (similarity >= this.options.similarityThreshold) {
          nodeList[i].addEdge(nodeList[j].id, similarity);
          nodeList[j].addEdge(nodeList[i].id, similarity);
        }
      }
    }

    return this.nodes.size;
  }

  /**
   * PageRank算法
   */
  _pageRank() {
    const nodes = Array.from(this.nodes.values());
    const n = nodes.length;
    if (n === 0) return;

    const d = this.options.dampingFactor;
    const initialPR = 1.0 / n;

    // 初始化
    for (const node of nodes) {
      node.pagerank = initialPR;
    }

    // 迭代计算
    for (let iter = 0; iter < this.options.maxIterations; iter++) {
      let maxDiff = 0;
      const newPR = new Map();

      for (const node of nodes) {
        let rank = (1 - d) / n;

        // 累加来自邻居的贡献
        for (const [neighborId, weight] of node.edges) {
          const neighbor = this.nodes.get(neighborId);
          if (neighbor) {
            const outDegree = neighbor.edges.size || 1;
            rank += d * (neighbor.pagerank * weight) / outDegree;
          }
        }

        newPR.set(node.id, rank);
        maxDiff = Math.max(maxDiff, Math.abs(rank - node.pagerank));
      }

      // 更新
      for (const node of nodes) {
        node.pagerank = newPR.get(node.id);
      }

      // 收敛检查
      if (maxDiff < this.options.convergenceThreshold) {
        console.log(`[GStack] PageRank收敛于第 ${iter + 1} 次迭代`);
        break;
      }
    }
  }

  /**
   * 社区发现（简单版 - 基于连通分量）
   */
  _detectCommunities() {
    const visited = new Set();
    let communityId = 0;

    for (const [nodeId, node] of this.nodes) {
      if (visited.has(nodeId)) continue;

      // BFS找到连通分量
      const queue = [node];
      visited.add(nodeId);
      node.community = communityId;

      while (queue.length > 0) {
        const current = queue.shift();
        for (const [neighborId] of current.edges) {
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            const neighbor = this.nodes.get(neighborId);
            if (neighbor) {
              neighbor.community = communityId;
              queue.push(neighbor);
            }
          }
        }
      }

      communityId++;
    }

    return communityId;
  }

  /**
   * 计算查询相关性
   */
  _queryRelevance(paper, query) {
    if (!query) return 0.5;

    const queryTokens = new Set(this._tokenize(query));
    if (queryTokens.size === 0) return 0.5;

    let score = 0;

    // 标题匹配
    if (paper.title) {
      const titleTokens = new Set(this._tokenize(paper.title));
      const titleOverlap =
        [...queryTokens].filter((x) => titleTokens.has(x)).length /
        queryTokens.size;
      score += titleOverlap * 0.4;
    }

    // 摘要匹配
    if (paper.abstract) {
      const absTokens = new Set(this._tokenize(paper.abstract));
      const absOverlap =
        [...queryTokens].filter((x) => absTokens.has(x)).length /
        queryTokens.size;
      score += absOverlap * 0.3;
    }

    // 关键词匹配
    if (paper.keywords?.length) {
      const kwTokens = new Set(
        paper.keywords.map((k) => String(k).toLowerCase())
      );
      const kwOverlap =
        [...queryTokens].filter((x) => kwTokens.has(x)).length /
        queryTokens.size;
      score += kwOverlap * 0.3;
    }

    return score;
  }

  /**
   * 应用来源权重
   */
  _applySourceWeight(paper) {
    const source = paper.source || "unknown";
    return this.options.sourceWeights[source] || 0.5;
  }

  /**
   * 融合排序
   */
  fuse(papers, query = "") {
    console.log(`[GStack] 开始融合: ${papers.length} 篇文献, 查询: "${query}"`);
    this.query = query;

    // 1. 构建图
    const nodeCount = this._buildGraph(papers);
    console.log(`[GStack] 图构建完成: ${nodeCount} 个节点`);

    // 2. PageRank
    this._pageRank();

    // 3. 社区发现
    const communityCount = this._detectCommunities();
    console.log(`[GStack] 发现 ${communityCount} 个社区`);

    // 4. 综合评分并排序
    const scored = [];
    for (const [nodeId, node] of this.nodes) {
      const paper = node.paper;

      // 综合分数 = PageRank * 查询相关性 * 来源权重
      const queryRel = this._queryRelevance(paper, query);
      const sourceWeight = this._applySourceWeight(paper);
      const finalScore = node.pagerank * (0.4 + queryRel * 0.4) * sourceWeight;

      scored.push({
        ...paper,
        gstack_score: finalScore,
        pagerank: node.pagerank,
        community: node.community,
        edge_count: node.edges.size,
      });
    }

    // 按分数降序排序
    scored.sort((a, b) => b.gstack_score - a.gstack_score);

    console.log(`[GStack] 融合完成: 最终 ${scored.length} 篇文献`);
    return scored;
  }

  /**
   * 获取图统计信息
   */
  getStats() {
    const nodes = Array.from(this.nodes.values());
    const totalEdges = nodes.reduce((sum, n) => sum + n.edges.size, 0) / 2;

    return {
      node_count: nodes.length,
      edge_count: totalEdges,
      communities: new Set(nodes.map((n) => n.community)).size,
      avg_pagerank:
        nodes.reduce((sum, n) => sum + n.pagerank, 0) / (nodes.length || 1),
      max_pagerank: Math.max(...nodes.map((n) => n.pagerank), 0),
    };
  }
}

/**
 * 快速融合（简化版）
 */
export function quickGStack(papers, query = "", options = {}) {
  const gstack = new GStack(options);
  return gstack.fuse(papers, query);
}

export default GStack;
