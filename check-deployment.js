#!/usr/bin/env node

/**
 * 联网搜索增强 - 部署前检查脚本
 * 自动验证所有配置和代码改动
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

let passCount = 0;
let warnCount = 0;
let failCount = 0;

function printHeader(text) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`${BLUE}${text}${RESET}`);
  console.log(`${"=".repeat(70)}\n`);
}

function checkPass(text) {
  console.log(`${GREEN}✓${RESET} ${text}`);
  passCount++;
}

function checkWarn(text) {
  console.log(`${YELLOW}⚠${RESET} ${text}`);
  warnCount++;
}

function checkFail(text) {
  console.log(`${RED}✗${RESET} ${text}`);
  failCount++;
}

function checkInfo(text) {
  console.log(`${BLUE}ℹ${RESET} ${text}`);
}

// 1. 检查配置文件
function checkEnvConfig() {
  printHeader("1. 检查 .env 配置");

  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    checkFail(".env 文件不存在");
    return;
  }

  const envContent = fs.readFileSync(envPath, 'utf8');

  const requiredConfigs = {
    'WEB_AI_SEARCH_PLANNER': '1',
    'WEB_AI_SEARCH_QUERY_MAX': '8',
    'WEB_AI_PLAN_TIMEOUT_MS': '18000',
    'WEB_ENTITY_QUERY_MAX': '24',
    'WEB_MULTI_QUERY_MAX': '16',
    'WEB_ROUND2_QUERY_MAX': '4',
  };

  for (const [key, expectedValue] of Object.entries(requiredConfigs)) {
    const regex = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm');
    const match = envContent.match(regex);

    if (match) {
      const actualValue = match[1].trim();
      if (actualValue === expectedValue) {
        checkPass(`${key}=${actualValue}`);
      } else {
        checkWarn(`${key}=${actualValue} (建议: ${expectedValue})`);
      }
    } else {
      checkFail(`${key} 未配置`);
    }
  }

  // 检查LLM Provider配置
  const llmKeys = ['LLM_PROVIDER_A_API_KEY', 'LLM_PROVIDER_A_BASE_URL', 'LLM_PROVIDER_A_MODEL'];
  let llmConfigured = true;
  for (const key of llmKeys) {
    if (!envContent.includes(key) || envContent.match(new RegExp(`${key}\\s*=\\s*$`, 'm'))) {
      llmConfigured = false;
      break;
    }
  }

  if (llmConfigured) {
    checkPass("LLM Provider A 已配置");
  } else {
    checkFail("LLM Provider A 未完整配置");
  }
}

// 2. 检查核心代码文件
function checkCodeFiles() {
  printHeader("2. 检查核心代码文件");

  const files = [
    {
      path: 'backend/webSearchAgent.js',
      checks: [
        { pattern: /temperature:\s*evidence\.length\s*>\s*0\s*\?\s*0\.3\s*:\s*0\.2/, desc: 'Temperature已优化 (0.2-0.3)' },
        { pattern: /maxTokens:\s*1000/, desc: 'maxTokens已提升 (1000)' },
        { pattern: /Math\.min\(12,/, desc: '查询上限已提升 (12)' },
        { pattern: /Strategy for multi-entity queries/, desc: '新增查询策略指导' },
        { pattern: /隆众资讯|卓创资讯/, desc: '包含中文数据源指导' },
      ]
    },
    {
      path: 'backend/searchService.js',
      checks: [
        { pattern: /Math\.min\(12,.*WEB_AI_SEARCH_QUERY_MAX/, desc: 'AI查询上限已调整 (12)' },
        { pattern: /Math\.min\(4,\s*aiQueryCap\)/, desc: '二轮补搜已提升 (4)' },
      ]
    }
  ];

  for (const file of files) {
    const filePath = path.join(__dirname, file.path);

    if (!fs.existsSync(filePath)) {
      checkFail(`${file.path} 文件不存在`);
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');

    checkInfo(`检查 ${file.path}:`);
    for (const check of file.checks) {
      if (check.pattern.test(content)) {
        checkPass(`  ${check.desc}`);
      } else {
        checkFail(`  ${check.desc} - 未找到`);
      }
    }
  }
}

// 3. 检查新增文件
function checkNewFiles() {
  printHeader("3. 检查新增文件");

  const newFiles = [
    'backend/webSearchAgentEnhanced.js',
    'backend/test/searchEnhancement.test.js',
    'backend/test/searchComparison.js',
    'SEARCH_ENHANCEMENT_GUIDE.md',
    'SEARCH_QUICKSTART.md',
    'CHANGELOG_SEARCH_ENHANCEMENT.md',
    'SEARCH_ENHANCEMENT_README.md',
    'IMPLEMENTATION_SUMMARY.md',
  ];

  for (const file of newFiles) {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      checkPass(`${file} (${(stats.size / 1024).toFixed(1)} KB)`);
    } else {
      checkFail(`${file} 不存在`);
    }
  }
}

// 4. 检查Git状态
function checkGitStatus() {
  printHeader("4. 检查 Git 状态");

  try {
    const status = execSync('git status --porcelain', { encoding: 'utf8' });

    if (status.trim()) {
      const lines = status.trim().split('\n');
      checkInfo(`有 ${lines.length} 个文件被修改:`);

      const modified = lines.filter(line => line.startsWith(' M')).length;
      const added = lines.filter(line => line.startsWith('??') || line.startsWith('A ')).length;

      console.log(`  修改: ${modified} 个文件`);
      console.log(`  新增: ${added} 个文件`);

      checkWarn("记得提交更改到Git");
    } else {
      checkPass("所有更改已提交");
    }
  } catch (error) {
    checkWarn("无法检查Git状态（可能不在Git仓库中）");
  }
}

// 5. 检查依赖
function checkDependencies() {
  printHeader("5. 检查依赖");

  const packageJsonPath = path.join(__dirname, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    checkWarn("package.json 不存在");
    return;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // 检查是否有测试脚本
  if (packageJson.scripts && packageJson.scripts.test) {
    checkPass("测试脚本已配置");
  } else {
    checkWarn("测试脚本未配置");
  }

  // 检查Node.js版本
  const nodeVersion = process.version;
  checkInfo(`Node.js 版本: ${nodeVersion}`);

  const major = parseInt(nodeVersion.slice(1).split('.')[0]);
  if (major >= 16) {
    checkPass("Node.js 版本符合要求 (>=16)");
  } else {
    checkWarn(`Node.js 版本较低 (${nodeVersion}), 建议升级到 16+`);
  }
}

// 6. 生成测试命令
function generateTestCommands() {
  printHeader("6. 测试命令");

  console.log("运行以下命令验证功能：\n");

  console.log(`${BLUE}1. 配置对比测试${RESET}`);
  console.log("   node backend/test/searchComparison.js\n");

  console.log(`${BLUE}2. 单元测试${RESET}`);
  console.log("   npm test backend/test/searchEnhancement.test.js\n");

  console.log(`${BLUE}3. 启动服务${RESET}`);
  console.log("   npm start\n");

  console.log(`${BLUE}4. 查看搜索日志${RESET}`);
  console.log("   # Windows PowerShell:");
  console.log("   Get-Content logs\\search.log -Tail 50 -Wait | Select-String \"web_ai_plan|entity_covered\"\n");
  console.log("   # Linux/Mac/Git Bash:");
  console.log("   tail -f logs/search.log | grep -E \"web_ai_plan|entity_covered\"\n");
}

// 7. 生成部署检查清单
function generateDeploymentChecklist() {
  printHeader("7. 部署检查清单");

  console.log("部署前请确认：\n");

  const checklist = [
    "配置文件 .env 已更新所有必需参数",
    "核心代码文件的改动已验证",
    "新增文件全部存在",
    "测试工具运行正常",
    "Git提交包含所有改动",
    "备份了原有配置（以便回滚）",
    "准备好监控日志和性能指标",
    "通知团队成员新功能上线",
  ];

  checklist.forEach((item, index) => {
    console.log(`[ ] ${index + 1}. ${item}`);
  });
}

// 8. 打印最终总结
function printSummary() {
  printHeader("检查总结");

  console.log(`通过: ${GREEN}${passCount}${RESET}`);
  console.log(`警告: ${YELLOW}${warnCount}${RESET}`);
  console.log(`失败: ${RED}${failCount}${RESET}`);
  console.log();

  if (failCount > 0) {
    console.log(`${RED}⚠ 有 ${failCount} 项检查失败，请先修复再部署${RESET}\n`);
    process.exit(1);
  } else if (warnCount > 0) {
    console.log(`${YELLOW}⚠ 有 ${warnCount} 项警告，建议检查后再部署${RESET}\n`);
  } else {
    console.log(`${GREEN}✓ 所有检查通过，可以部署！${RESET}\n`);
  }
}

// 主函数
function main() {
  console.clear();
  console.log(`${BLUE}╔════════════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BLUE}║                  联网搜索增强 - 部署前检查                         ║${RESET}`);
  console.log(`${BLUE}╚════════════════════════════════════════════════════════════════════╝${RESET}`);

  checkEnvConfig();
  checkCodeFiles();
  checkNewFiles();
  checkGitStatus();
  checkDependencies();
  generateTestCommands();
  generateDeploymentChecklist();
  printSummary();
}

// 运行
main();
