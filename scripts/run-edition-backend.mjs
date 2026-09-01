import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const edition = process.argv[2] === "enterprise" ? "enterprise" : "school";
const configuredPort = edition === "enterprise"
  ? process.env.ENTERPRISE_API_PORT
  : process.env.SCHOOL_API_PORT ?? process.env.PORT;

process.env.APP_EDITION = edition;
process.env.PORT = String(configuredPort || (edition === "enterprise" ? 8788 : 8787));

await import("../backend/index.js");
