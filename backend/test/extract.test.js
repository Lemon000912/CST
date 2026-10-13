import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";
import { extractDocumentText, normalizeUploadedFilename } from "../extract.js";

test("multipart UTF-8 filenames decoded as Latin-1 are restored", () => {
  const filename = "新材料首批次应用示范目录_2024_原文(1).xlsx";
  const mojibake = Buffer.from(filename, "utf8").toString("latin1");
  assert.equal(normalizeUploadedFilename(mojibake), filename);
  assert.equal(normalizeUploadedFilename(filename), filename);
  assert.equal(normalizeUploadedFilename("rapport-é.xlsx"), "rapport-é.xlsx");
});

test("xlsx extraction preserves workbook sheet order and tabular cell values", async () => {
  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    '<?xml version="1.0"?><workbook xmlns:r="urn:relationships"><sheets><sheet name="财务 &amp; 指标" sheetId="1" r:id="rId2"/><sheet name="备注" sheetId="2" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet2.xml"/><Relationship Id="rId2" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file("xl/sharedStrings.xml", "<sst><si><t>公司</t></si><si><r><t>营业</t></r><r><t>收入</t></r></si></sst>");
  zip.file(
    "xl/worksheets/sheet1.xml",
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>2025 年</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>125.5</v></c></row></sheetData></worksheet>',
  );
  zip.file("xl/worksheets/sheet2.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>备注内容</t></is></c></row></sheetData></worksheet>');

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const text = await extractDocumentText(buffer, "财报.xlsx");
  assert.equal(
    text,
    "【工作表：财务 & 指标】\n公司\t\t2025 年\n营业收入\t\t125.5\n\n【工作表：备注】\n备注内容",
  );
});

test("CSV and TSV uploads are read as text", async () => {
  assert.equal(await extractDocumentText(Buffer.from("年份,营收\n2025,12"), "data.csv"), "年份,营收\n2025,12");
  assert.equal(await extractDocumentText(Buffer.from("年份\t营收\n2025\t12"), "data.tsv"), "年份\t营收\n2025\t12");
});

test("legacy binary xls files remain rejected with supported format guidance", async () => {
  await assert.rejects(extractDocumentText(Buffer.from("old excel"), "legacy.xls"), /xlsx、csv、tsv/);
});
