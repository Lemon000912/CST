import test from "node:test";
import assert from "node:assert/strict";
import { extractDataTableByType } from "../dataTableExtract.js";

const input = { tableType: "performance", papers: [{ title: "示例", abstract: "样品容量为 100 mAh/g。", doi: "10.0000/example" }] };
const valid = { title: "容量对比", rows: [{ metric: "容量", value: "100", unit: "mAh/g", source_ref: "[1]" }] };
const completion = (content, finish_reason = "stop", reasoning_content = "") => ({
  choices: [{ message: { content, reasoning_content }, finish_reason }],
});

function setup(t, responses) {
  const config = { LLM_PROVIDER_A_API_KEY: "test-only", LLM_PROVIDER_A_BASE_URL: "https://model.example/v1", LLM_PROVIDER_A_MODEL: "test-model" };
  const previous = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  Object.assign(process.env, config);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const response = responses[calls.length - 1];
    assert.ok(response, "unexpected extra model call");
    return new Response(JSON.stringify(response.body ?? response), { status: response.status ?? 200, headers: { "Content-Type": "application/json" } });
  });
  return calls;
}

test("完整 JSON 使用 16000 token 并保留指标与来源", async t => {
  const calls = setup(t, [completion(JSON.stringify(valid))]);
  const result = await extractDataTableByType(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, valid.rows);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].max_tokens, 16000);
});

test("截断后精简重试一次，保持同一份原始材料和引用编号", async t => {
  const calls = setup(t, [completion(JSON.stringify(valid), "length"), completion(JSON.stringify(valid))]);
  const result = await extractDataTableByType(input);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].max_tokens, 16000);
  assert.equal(calls[0].messages[1].content, calls[1].messages[1].content);
  assert.match(calls[1].messages[0].content, /最多输出 40 行/);
});

for (const [label, failed, code, message] of [
  ["连续截断", completion('{"rows":[', "length"), "data-table-truncated", /输出被截断/],
  ["大小写不同的截断状态", completion("", "MAX_TOKENS"), "data-table-truncated", /输出被截断/],
  ["只有思考", completion("", "stop", JSON.stringify(valid)), "data-table-empty-content", /未返回表格正文/],
  ["完全空响应", completion(""), "data-table-empty-content", /未返回表格正文/],
  ["非法 JSON", completion('{"rows":[}'), "data-table-invalid-json", /JSON 格式错误/],
  ["纯文本", completion("以下是表格"), "data-table-invalid-json", /JSON 格式错误/],
  ["缺失行数组", completion('{"title":"错误","rows":{}}'), "data-table-invalid-json", /JSON 格式错误/],
]) {
  test(`${label}最多重试一次并返回准确提示`, async t => {
    const calls = setup(t, [failed, failed]);
    const result = await extractDataTableByType(input);
    assert.equal(calls.length, 2);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.match(result.error, message);
    assert.deepEqual(result.rows, []);
  });
}

test("没有可抽取数据时空数组是成功结果，不触发重试", async t => {
  const calls = setup(t, [completion('{"rows":[]}')]);
  const result = await extractDataTableByType(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, []);
  assert.equal(calls.length, 1);
});

test("兼容 JSON 围栏和旧字段名称", async t => {
  setup(t, [completion('```json\n'+JSON.stringify({ extractedData: valid.rows })+'\n```')]);
  const result = await extractDataTableByType(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, valid.rows);
});

test("上游鉴权失败不进行格式重试", async t => {
  const calls = setup(t, [{ status: 401, body: { error: "upstream-auth-failed" } }]);
  const result = await extractDataTableByType(input);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
});
