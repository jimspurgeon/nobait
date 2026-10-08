import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/firefox',
    rollupOptions: {
      input: {
        content: './src/content/index.ts',
        background: './src/background/index.ts',
      },
      output: {
        entryFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
        chunkFileNames: 'chunks/[name].js',
      },
    },
  },
});
