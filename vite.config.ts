import { defineConfig } from 'vite';
import { resolve } from 'path';
import { cpSync } from 'node:fs';

const target = process.env.VITE_TARGET || 'firefox';

export default defineConfig(({ mode }) => ({
  build: {
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        options: resolve(__dirname, 'src/options/index.html')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].[hash].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    },
    sourcemap: mode === 'development',
    minify: mode === 'production',
    outDir: `dist/${target}`,
    // Emit a content.css for the content script (manifest references it).
    cssCodeSplit: true,
    closeBundle() {
      // src/manifest.json is canonical — place it at the dist root.
      cpSync(resolve(__dirname, 'src/manifest.json'), resolve(__dirname, `dist/${target}/manifest.json`));
      cpSync(resolve(__dirname, 'src/styles/base.css'), resolve(__dirname, `dist/${target}/content.css`));
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode)
  }
}));
