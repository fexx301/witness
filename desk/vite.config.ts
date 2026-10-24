import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The desk never talks to PayPal or a model directly: /api goes to the Witness server, which holds the keys.
// A visitor reaching this dev server from another machine is passed on as one (X-Forwarded-For), so Witness
// never mistakes them for this machine and lets them execute.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8790",
        configure: (proxy) =>
          proxy.on("proxyReq", (proxyReq, req) => {
            const address = req.socket.remoteAddress ?? "";
            if (!LOOPBACK.has(address)) proxyReq.setHeader("x-forwarded-for", address);
          }),
      },
    },
  },
});
