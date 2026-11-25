import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ base: './', plugins: [react()], root: 'writer', build: { outDir: '../writer-dist', emptyOutDir: true }, server: { port: 5174 } })
