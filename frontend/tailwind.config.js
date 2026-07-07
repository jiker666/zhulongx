/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        obsidian: { 950: '#06080f', 900: '#0a0e1a', 800: '#0d1426', 700: '#111827', 600: '#1f2937', 500: '#374151' },
        ember:    { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309' },
        cyan:     { 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2' },
        crimson:  { 400: '#f87171', 500: '#ef4444', 600: '#dc2626' },
        violet:   { 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed' },
        jade:     { 400: '#4ade80', 500: '#22c55e', 600: '#16a34a' },
      },
    },
  },
  plugins: [],
}
