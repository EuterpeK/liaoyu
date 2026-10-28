import vue from '@vitejs/plugin-vue';
import { TDesignResolver } from 'unplugin-vue-components/resolvers';
import Components from 'unplugin-vue-components/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/admin/',
  plugins: [vue(), Components({ resolvers: [TDesignResolver({ library: 'vue-next' })], dts: false })],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8700' } },
  test: { environment: 'happy-dom', include: ['src/**/*.test.ts'] },
});
