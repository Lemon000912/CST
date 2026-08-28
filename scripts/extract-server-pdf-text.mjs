import fs from "node:fs/promises";
import path from "node:path";

import { extractDocumentText } from "../backend/extract.js";

const filePath = path.resolve(String(process.argv[2] ?? ""));
if (!filePath || path.extname(filePath).toLowerCase() !== ".pdf") {
  throw new Error("A PDF file path is required");
}

const buffer = await fs.readFile(filePath);
const text = await extractDocumentText(buffer, path.basename(filePath));
process.stdout.write(text);
