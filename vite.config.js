// The development server (`npm run dev`) and `npm run preview` answer the
// app's requests to pause and resume other audio, as the stable app does.
import { defineConfig } from 'vite';
import { handleMediaRequest } from './scripts/media.mjs';

// A block body: a function returned from these hooks would run as a post hook.
function media(server) {
  server.middlewares.use((req, res, next) => handleMediaRequest(req, res) || next());
}

export default defineConfig({
  plugins: [{ name: 'read-aloud-media', configureServer: media, configurePreviewServer: media }],
});
