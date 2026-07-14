/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        obsidian: { 950: '#050712', 900: '#090d18', 850: '#0c1220', 800: '#101827', 700: '#172033', 600: '#233049', 500: '#33415f' },
        ember:    { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309' },
        cyan:     { 300: '#67e8f9', 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2' },
        crimson:  { 300: '#fca5a5', 400: '#f87171', 500: '#ef4444', 600: '#dc2626' },
        violet:   { 300: '#c4b5fd', 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed' },
        jade:     { 300: '#86efac', 400: '#4ade80', 500: '#22c55e', 600: '#16a34a' },
      },
      boxShadow: {
        glass: '0 20px 80px rgba(0, 0, 0, 0.35)',
        'ember-glow': '0 0 32px rgba(245, 158, 11, 0.18)',
        'cyan-glow': '0 0 32px rgba(6, 182, 212, 0.16)',
      },
      backgroundImage: {
        'command-grid': 'linear-gradient(rgba(148,163,184,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,.06) 1px, transparent 1px)',
        'obsidian-noise': 'radial-gradient(circle at 20% 0%, rgba(245,158,11,.12), transparent 32%), radial-gradient(circle at 80% 12%, rgba(34,211,238,.10), transparent 32%), radial-gradient(circle at 55% 90%, rgba(139,92,246,.08), transparent 38%)',
      },
      keyframes: {
        scan: {
          '0%': { transform: 'translateX(-30%)', opacity: '.15' },
          '50%': { opacity: '.45' },
          '100%': { transform: 'translateX(130%)', opacity: '.15' },
        },
        'evidence-flow': {
          '0%': { strokeDashoffset: '60' },
          '100%': { strokeDashoffset: '0' },
        },
      },
      animation: {
        scan: 'scan 8s ease-in-out infinite',
        'evidence-flow': 'evidence-flow 3.5s linear infinite',
      },
    },
  },
  plugins: [],
}
