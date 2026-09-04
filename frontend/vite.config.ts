import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const edition = mode === "enterprise" || env.VITE_APP_EDITION === "enterprise"
    ? "enterprise"
    : "school";
  const apiPort = String(
    edition === "enterprise"
      ? env.ENTERPRISE_API_PORT ?? "8788"
      : env.SCHOOL_API_PORT ?? env.PORT ?? "8787",
  ).trim() || (edition === "enterprise" ? "8788" : "8787");
  const devPort = Number(
    edition === "enterprise"
      ? env.ENTERPRISE_DEV_PORT ?? 5176
      : env.SCHOOL_DEV_PORT ?? env.VITE_DEV_PORT ?? 5175,
  ) || (edition === "enterprise" ? 5176 : 5175);
  const apiProxy = {
    "/api": {
      target: `http://127.0.0.1:${apiPort}`,
      changeOrigin: true,
      /** 深度管线：MinerU + 多模型，单次请求可能数分钟 */
      timeout: 900_000,
      proxyTimeout: 900_000,
    },
  } as const;

  return {
    root: __dirname,
    plugins: [react()],
    define: {
      "import.meta.env.VITE_APP_EDITION": JSON.stringify(edition),
    },
    build: {
      outDir: path.resolve(repoRoot, `dist-${edition}`),
      emptyOutDir: true,
    },
    server: {
      /** 0.0.0.0：允许局域网/路由器端口转发（仅 127.0.0.1 时外网 19012→5175 会连不上） */
      host: true,
      port: devPort,
      strictPort: true,
      proxy: { ...apiProxy },
    },
    preview: {
      host: true,
      port: devPort,
      strictPort: true,
      proxy: { ...apiProxy },
    },
  };
});
