import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const apiPort = String(env.PORT ?? "8787").trim() || "8787";
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
    server: {
      /** 0.0.0.0：允许局域网/路由器端口转发（仅 127.0.0.1 时外网 19012→5175 会连不上） */
      host: true,
      port: Number(env.VITE_DEV_PORT ?? 5175) || 5175,
      strictPort: true,
      proxy: { ...apiProxy },
    },
    preview: {
      host: true,
      port: Number(env.VITE_DEV_PORT ?? 5175) || 5175,
      strictPort: true,
      proxy: { ...apiProxy },
    },
  };
});
