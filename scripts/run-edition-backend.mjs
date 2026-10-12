import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const requestedEdition = String(process.argv[2] ?? "").trim().toLowerCase();
const edition = requestedEdition === "enterprise" || requestedEdition === "finance"
  ? requestedEdition
  : "school";
const configuredPort = edition === "enterprise"
  ? process.env.ENTERPRISE_API_PORT
  : edition === "finance"
    ? process.env.FINANCE_API_PORT
    : process.env.SCHOOL_API_PORT ?? process.env.PORT;

process.env.APP_EDITION = edition;
process.env.PORT = String(configuredPort || (edition === "enterprise" ? 8788 : edition === "finance" ? 8789 : 8787));

await import("../backend/index.js");
