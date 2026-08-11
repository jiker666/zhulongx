import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = "http://127.0.0.1:7318";
const apiToken = process.env.XUANSHU_SERVER_TOKEN;
const apiProxy = {
  target: apiTarget,
  ...(apiToken ? { headers: { authorization: `Bearer ${apiToken}` } } : {}),
};

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/v1": apiProxy, "/health": apiProxy } },
});
