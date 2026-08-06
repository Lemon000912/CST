/**
 * GBrain - 知识图谱大脑
 * 
 * 核心功能：
 * 1. 构建用户知识图谱（基于搜索历史、下载记录、反馈）
 * 2. 实体识别与关系抽取
 * 3. 知识推理与推荐
 * 4. 用户画像增强
 * 
 * 与GStack的关系：
 * - GStack负责单次搜索结果的图融合排序
 * - GBrain负责长期知识积累和用户理解
 */

import { createHash } from "crypto";

/**
 * 知识图谱实体
 */
class Entity {
  constructor(id, type, name, properties = {}) {
    this.id = id;
    this.type = type; // 'paper', 'author', 'keyword', 'concept', 'method'
    this.name = name;
    this.properties = properties;
    this.relations = new Map(); // entityId -> relationType
    this.weight = 1.0; // 实体重要性权重
    this.occurrenceCount = 1; // 出现次数
  }

  addRelation(entityId, relationType, weight = 1.0) {
    const key = `${entityId}:${relationType}`;
    const current = this.relations.get(key) || { type: relationType, weight: 0 };
    current.weight += weight;
    this.relations.set(key, current);
  }
}

/**
 * GBrain 知识图谱大脑
 */
export class GBrain {
  constructor(options = {}) {
    this.options = {
      maxEntities: options.maxEntities || 10000,
      decayFactor: options.decayFactor || 0.95, // 时间衰减因子
      minOccurrence: options.minOccurrence || 2, // 最小出现次数
      ...options,
    };
    
    // 实体存储
    this.entities = new Map(); // id -> Entity
    
    // 用户行为记录
    this.userBehavior = {
      queries: [], // 历史查询
      downloads: [], // 下载记录
      feedback: [], // 反馈记录
      interests: new Map(), // 兴趣度
    };
    
    // 知识图谱统计
    this.stats = {
      totalEntities: 0,
      totalRelations: 0,
      lastUpdate: null,
    };
  }

  /**
   * 从文本中提取实体（中英文：公司名、材料词、英文术语）
   */
  _extractEntities(text, type = "keyword") {
    const s = String(text ?? "").trim();
    if (!s) return [];

    const stopZh = new Set(
      "什么 怎么 如何 为什么 哪些 请问 用户 助手 对话 上下文 摘录 检索 联网 回答 当前 提问 材料 性能".split(
        " ",
      ),
    );
    const freq = new Map();
    const bump = (word, w = 1) => {
      const t = String(word ?? "").trim();
      if (!t || t.length < 2) return;
      if (stopZh.has(t)) return;
      const key = /[\u4e00-\u9fff]/.test(t) ? t : t.toLowerCase();
      freq.set(key, (freq.get(key) || 0) + w);
    };

    for (const m of s.matchAll(/[\u4e00-\u9fff]{2,24}(?:有限公司|股份公司|集团有限公司|公司|集团|股份)?/g)) {
      bump(m[0], 3);
    }
    for (const m of s.matchAll(/[\u4e00-\u9fff]{2,8}/g)) {
      bump(m[0], 1);
    }
    for (const m of s.matchAll(/\b[A-Za-z][A-Za-z0-9._-]{1,31}\b/g)) {
      const w = m[0];
      if (w.length >= 3) bump(w, 2);
    }

    return Array.from(freq.entries())
      .filter(([word]) => word.length >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([word, count]) => ({
        id: this._hashId(word),
        name: word,
        type,
        weight: count,
      }));
  }

  /**
   * 生成实体ID
   */
  _hashId(str) {
    return createHash("md5").update(str).digest("hex").slice(0, 12);
  }

  /**
   * 添加或更新实体
   */
  _addEntity(entity) {
    const existing = this.entities.get(entity.id);
    if (existing) {
      existing.occurrenceCount += 1;
      existing.weight += entity.weight;
      // 合并属性
      Object.assign(existing.properties, entity.properties);
    } else {
      this.entities.set(entity.id, new Entity(
        entity.id,
        entity.type,
        entity.name,
        entity.properties
      ));
      this.entities.get(entity.id).weight = entity.weight;
      this.stats.totalEntities++;
    }
    
    this.stats.lastUpdate = Date.now();
  }

  /**
   * 记录用户查询
   */
  recordQuery(query, results = []) {
    const timestamp = Date.now();
    
    this.userBehavior.queries.push({
      query,
      timestamp,
      resultCount: results.length,
    });
    
    // 从查询中提取关键词实体
    const queryEntities = this._extractEntities(query, "keyword");
    for (const entity of queryEntities) {
      this._addEntity(entity);
      
      // 更新兴趣度
      const currentInterest = this.userBehavior.interests.get(entity.id) || 0;
      this.userBehavior.interests.set(entity.id, currentInterest + 1);
    }
    
    // 从结果中提取实体并建立关系
    for (const result of results) {
      this._processPaper(result, queryEntities);
    }
    
    console.log(`[GBrain] 记录查询: "${query}", 提取 ${queryEntities.length} 个实体`);
  }

  /**
   * 处理文献，提取实体和关系
   */
  _processPaper(paper, queryEntities = []) {
    // 添加文献实体
    const paperId = paper.doi || paper.id || this._hashId(paper.title);
    this._addEntity({
      id: paperId,
      name: paper.title,
      type: "paper",
      weight: 1,
      properties: {
        year: paper.year,
        authors: paper.authors,
        source: paper.source,
      },
    });
    
    // 提取作者实体
    if (paper.authors) {
      for (const author of paper.authors) {
        const authorId = this._hashId(`author:${author}`);
        this._addEntity({
          id: authorId,
          name: author,
          type: "author",
          weight: 0.5,
        });
        
        // 建立作者-文献关系
        const paperEntity = this.entities.get(paperId);
        if (paperEntity) {
          paperEntity.addRelation(authorId, "authored_by", 1.0);
        }
      }
    }
    
    // 提取关键词实体
    const paperKeywords = this._extractEntities(
      `${paper.title} ${paper.abstract || ""}`,
      "keyword"
    );
    
    for (const kw of paperKeywords) {
      this._addEntity(kw);
      
      // 建立文献-关键词关系
      const paperEntity = this.entities.get(paperId);
      if (paperEntity) {
        paperEntity.addRelation(kw.id, "has_keyword", kw.weight);
      }
      
      // 建立查询-关键词关系
      for (const qe of queryEntities) {
        const kwEntity = this.entities.get(kw.id);
        if (kwEntity) {
          kwEntity.addRelation(qe.id, "related_to", 0.5);
        }
      }
    }
  }

  /**
   * 记录用户下载
   */
  recordDownload(paper) {
    const timestamp = Date.now();
    
    this.userBehavior.downloads.push({
      paperId: paper.doi || paper.id,
      title: paper.title,
      timestamp,
    });
    
    // 下载的文献权重更高
    this._processPaper(paper);
    const paperId = paper.doi || paper.id || this._hashId(paper.title);
    const entity = this.entities.get(paperId);
    if (entity) {
      entity.weight += 5; // 下载增加更多权重
    }
    
    console.log(`[GBrain] 记录下载: "${paper.title}"`);
  }

  /**
   * 记录用户反馈
   */
  recordFeedback(query, answer, value) {
    const timestamp = Date.now();
    
    this.userBehavior.feedback.push({
      query,
      answer: answer?.slice?.(0, 200) || "",
      value, // 1 = good, -1 = bad
      timestamp,
    });
    
    // 根据反馈调整兴趣度
    const queryEntities = this._extractEntities(query, "keyword");
    for (const entity of queryEntities) {
      const currentInterest = this.userBehavior.interests.get(entity.id) || 0;
      const adjustment = value > 0 ? 2 : -1; // good +2, bad -1
      this.userBehavior.interests.set(
        entity.id,
        Math.max(0, currentInterest + adjustment)
      );
    }
    
    console.log(`[GBrain] 记录反馈: ${value > 0 ? "good" : "bad"}`);
  }

  /**
   * 获取用户兴趣画像
   */
  getUserProfile() {
    // 按兴趣度排序
    const sortedInterests = Array.from(this.userBehavior.interests.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    
    const topInterests = sortedInterests
      .map(([id, score]) => {
        const entity = this.entities.get(id);
        return {
          id,
          name: entity?.name || id,
          type: entity?.type || "unknown",
          score,
        };
      })
      .filter((item) => item.score >= this.options.minOccurrence);
    
    // 计算行为统计
    const queryCount = this.userBehavior.queries.length;
    const downloadCount = this.userBehavior.downloads.length;
    const feedbackCount = this.userBehavior.feedback.length;
    const positiveFeedback = this.userBehavior.feedback.filter(
      (f) => f.value > 0
    ).length;
    
    return {
      topInterests,
      behavior: {
        queryCount,
        downloadCount,
        feedbackCount,
        positiveFeedback,
        positiveRate: feedbackCount > 0 ? positiveFeedback / feedbackCount : 0,
      },
      knowledgeGraph: {
        entityCount: this.stats.totalEntities,
        relationCount: this.stats.totalRelations,
        lastUpdate: this.stats.lastUpdate,
      },
    };
  }

  /**
   * 获取推荐关键词（基于知识图谱）
   */
  getRecommendations(query, limit = 5) {
    const queryEntities = this._extractEntities(query, "keyword");
    const recommendations = [];
    
    // 找到与查询实体相关的实体
    for (const qe of queryEntities) {
      const entity = this.entities.get(qe.id);
      if (!entity) continue;
      
      for (const [key, relation] of entity.relations) {
        const [relatedId] = key.split(":");
        const relatedEntity = this.entities.get(relatedId);
        if (relatedEntity && relatedEntity.type === "keyword") {
          recommendations.push({
            name: relatedEntity.name,
            type: relatedEntity.type,
            weight: relation.weight * entity.weight,
            relationType: relation.type,
          });
        }
      }
    }
    
    // 按权重排序并去重
    const seen = new Set();
    return recommendations
      .sort((a, b) => b.weight - a.weight)
      .filter((item) => {
        if (seen.has(item.name)) return false;
        seen.add(item.name);
        return true;
      })
      .slice(0, limit);
  }

  /**
   * 生成用户Skill文本（用于LLM提示）
   */
  generateUserSkill() {
    const profile = this.getUserProfile();
    const topInterests = profile.topInterests.slice(0, 10);
    
    if (topInterests.length === 0) {
      return "## 用户画像\n暂无足够数据生成用户画像。";
    }
    
    const interestsText = topInterests
      .map((item, i) => `${i + 1}. ${item.name} (关注度: ${item.score.toFixed(1)})`)
      .join("\n");
    
    const behavior = profile.behavior;
    
    return [
      "## 用户画像与偏好",
      "",
      "### 主要研究兴趣",
      interestsText,
      "",
      "### 行为统计",
      `- 历史查询: ${behavior.queryCount} 次`,
      `- 下载文献: ${behavior.downloadCount} 篇`,
      `- 反馈记录: ${behavior.feedbackCount} 条 (好评率: ${(behavior.positiveRate * 100).toFixed(1)}%)`,
      "",
      "### 检索偏好",
      "- 优先推荐与用户兴趣相关的文献",
      "- 关注高频出现的主题和方法",
      "- 考虑用户的历史反馈调整推荐",
    ].join("\n");
  }

  /**
   * 导出知识图谱（用于可视化）
   */
  exportGraph() {
    const nodes = [];
    const edges = [];
    
    for (const [id, entity] of this.entities) {
      if (entity.occurrenceCount < this.options.minOccurrence) continue;
      
      nodes.push({
        id,
        name: entity.name,
        type: entity.type,
        weight: entity.weight,
        occurrence: entity.occurrenceCount,
      });
      
      for (const [key, relation] of entity.relations) {
        const [targetId] = key.split(":");
        edges.push({
          source: id,
          target: targetId,
          type: relation.type,
          weight: relation.weight,
        });
      }
    }
    
    return { nodes, edges };
  }

  /**
   * 清理过期数据
   */
  cleanup() {
    const now = Date.now();
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30天
    
    // 清理旧查询
    this.userBehavior.queries = this.userBehavior.queries.filter(
      (q) => now - q.timestamp < maxAge
    );
    
    // 清理旧下载
    this.userBehavior.downloads = this.userBehavior.downloads.filter(
      (d) => now - d.timestamp < maxAge
    );
    
    // 清理低频实体
    for (const [id, entity] of this.entities) {
      if (entity.occurrenceCount < this.options.minOccurrence) {
        this.entities.delete(id);
        this.stats.totalEntities--;
      }
    }
    
    console.log(`[GBrain] 清理完成: 剩余 ${this.stats.totalEntities} 个实体`);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      queryCount: this.userBehavior.queries.length,
      downloadCount: this.userBehavior.downloads.length,
      feedbackCount: this.userBehavior.feedback.length,
      interestCount: this.userBehavior.interests.size,
    };
  }
}

/**
 * 全局GBrain实例（单例）
 */
let globalGBrain = null;

export function getGBrain() {
  if (!globalGBrain) {
    globalGBrain = new GBrain();
  }
  return globalGBrain;
}

export function resetGBrain() {
  globalGBrain = new GBrain();
  return globalGBrain;
}

export default GBrain;
