import { defineConfig } from 'vite';
import { resolve } from 'path';

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
    outDir: `dist/${target}`
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode)
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/__tests__/**/*.test.ts']
  }
}));
