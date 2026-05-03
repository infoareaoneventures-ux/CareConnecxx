import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import compression from 'vite-plugin-compression';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // Gzip compression for assets (disabled for low-memory builds; Firebase Hosting gzips on serve)
    process.env.NO_COMPRESS ? null : compression({
      algorithm: 'gzip',
      ext: '.gz',
      threshold: 1024,
      deleteOriginFile: false,
    }),
    process.env.NO_COMPRESS ? null : compression({
      algorithm: 'brotliCompress',
      ext: '.br',
      threshold: 1024,
      deleteOriginFile: false,
    }),
    // Bundle analyzer (only in analyze mode)
    mode === 'analyze' && visualizer({
      open: true,
      gzipSize: true,
      brotliSize: true,
      filename: 'dist/stats.html',
    }),
  ].filter(Boolean),
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Target modern browsers for smaller bundles
    target: 'esnext',
    // Minification options — use esbuild minifier by default (lighter memory than terser)
    minify: process.env.USE_TERSER ? 'terser' : 'esbuild',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
        pure_funcs: ['console.log', 'console.info', 'console.debug'],
      },
      format: {
        comments: false,
      },
    },
    // Chunk size warning (in KB)
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        // Simplified chunking - let Vite handle it mostly automatically
        manualChunks: {
          // Only split Firebase (large) and icons
          'firebase': ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/functions', 'firebase/storage', 'firebase/messaging'],
          'icons': ['lucide-react'],
        },
        // Asset naming for better caching
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          const info = assetInfo.name.split('.');
          const ext = info[info.length - 1];
          if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(assetInfo.name)) {
            return 'assets/images/[name]-[hash][extname]';
          }
          if (ext === 'css') {
            return 'assets/styles/[name]-[hash][extname]';
          }
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
  // Optimize dependencies
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      'firebase/app',
      'firebase/auth',
      'firebase/firestore',
      'lucide-react',
    ],
    exclude: ['@firebase/auth', '@firebase/firestore'],
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
  },
  // CSS optimization
  css: {
    devSourcemap: false,
  },
}));