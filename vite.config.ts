import path from "node:path";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import sirv from "sirv";

const assetsDir = path.resolve(__dirname, "assets");

export default defineConfig({
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  plugins: [
    {
      name: "serve-live2d-assets",
      configureServer(server) {
        server.middlewares.use("/assets", sirv(assetsDir, { dev: true, etag: true }));
      },
      configurePreviewServer(server) {
        server.middlewares.use("/assets", sirv(assetsDir, { dev: true, etag: true }));
      },
    },
    viteStaticCopy({
      targets: [{ src: "assets/**/*", dest: "assets" }],
    }),
  ],
});
