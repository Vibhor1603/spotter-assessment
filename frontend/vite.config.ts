import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // MapLibre v6 worker breaks under dep pre-bundling (GeoJSON layers never paint).
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
})
