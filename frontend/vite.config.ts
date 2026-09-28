import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],

  // 产物目录叫 build/ —— 与彩翻的前端交付流程保持一致（Dockerfile 里 COPY ./build）。
  build: {
    outDir: 'build',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // 把体积大且几乎不变的依赖单独分包：改业务代码时用户不必重新下载整个供应商包。
        // 文件名带 hash，配合 nginx 的 /assets/ 长缓存才有效。
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          antd: ['antd', '@ant-design/icons'],
        },
      },
    },
  },

  server: {
    port: 5173,
    // 开发态把 /api 代理到后端；生产态由 nginx 干同一件事。
    proxy: {
      '/api': {
        target: process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
