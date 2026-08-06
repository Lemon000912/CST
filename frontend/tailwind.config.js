import typography from "@tailwindcss/typography";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [path.join(__dirname, "index.html"), path.join(__dirname, "src/**/*.{js,ts,jsx,tsx}")],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "PingFang SC",
          "Microsoft YaHei",
          "Noto Sans SC",
          "Helvetica Neue",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
      },
      typography: {
        DEFAULT: {
          css: {
            fontFamily:
              'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Helvetica Neue", Helvetica, Arial, sans-serif',
            "--tw-prose-body": "var(--t-text)",
            "--tw-prose-headings": "var(--t-text-heading)",
            "--tw-prose-bold": "var(--t-text-strong)",
            "--tw-prose-links": "var(--t-prose-link)",
          },
        },
        invert: {
          css: {
            fontFamily:
              'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Helvetica Neue", Helvetica, Arial, sans-serif',
          },
        },
        slate: {
          css: {
            fontFamily:
              'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Helvetica Neue", Helvetica, Arial, sans-serif',
          },
        },
      },
      colors: {
        surface: {
          DEFAULT: "var(--t-surface)",
          raised: "var(--t-elevated)",
          hover: "var(--t-muted-hover)",
        },
        border: { subtle: "var(--t-border-line)" },
      },
    },
  },
  plugins: [typography],
};
