import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The desk never talks to PayPal or a model directly: /api goes to the Witness server, which holds the keys.
export default defineConfig({ plugins: [react()], server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8790" } } });
