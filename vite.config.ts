import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { build as esbuild, context as esbuildContext, type BuildContext } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import manifest from './manifest.json';

const root = path.dirname(fileURLToPath(import.meta.url));
const injectedOutDir = path.resolve(root, 'public/generated');

const injectedEntryPoints = {
  'page-script': path.resolve(root, 'src/content/page-script.ts'),
  content: path.resolve(root, 'src/content/index.ts'),
};

async function buildInjectedScripts(): Promise<void> {
  await esbuild({
    entryPoints: injectedEntryPoints,
    outdir: injectedOutDir,
    bundle: true,
    format: 'iife',
    target: 'chrome110',
    sourcemap: false,
    logLevel: 'silent',
  });
}

function injectedScriptsPlugin(): Plugin {
  let context: BuildContext | undefined;

  return {
    name: 'wpa-injected-scripts',
    async buildStart() {
      await buildInjectedScripts();
    },
    configureServer(server) {
      server.httpServer?.once('listening', async () => {
        context = await esbuildContext({
          entryPoints: injectedEntryPoints,
          outdir: injectedOutDir,
          bundle: true,
          format: 'iife',
          target: 'chrome110',
          sourcemap: false,
          logLevel: 'silent',
        });
        await context.watch();
      });

      server.httpServer?.once('close', () => {
        void context?.dispose();
        context = undefined;
      });
    },
    async closeBundle() {
      await context?.dispose();
      context = undefined;
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
    },
  },
  plugins: [
    tailwindcss(),
    react(),
    injectedScriptsPlugin(),
    crx({ manifest }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
  build: {
    rollupOptions: {
      // Built as an alternative surface when the Side Panel API is missing;
      // registered dynamically via chrome.action.setPopup in the background.
      input: {
        popup: path.resolve(root, 'src/popup/index.html'),
      },
    },
  },
});
