import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    // Для GitHub Pages сайт живёт в подкаталоге: VITE_BASE=/<репозиторий>/
    base: process.env.VITE_BASE ?? '/',
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': { target: 'http://localhost:8000', changeOrigin: false },
        },
    },
    build: {
        chunkSizeWarningLimit: 2000,
    },
});
