/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        paper: 'rgb(var(--paper) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        sunk: 'rgb(var(--sunk) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        'line-soft': 'rgb(var(--line-soft) / <alpha-value>)',
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          soft: 'rgb(var(--ink-soft) / <alpha-value>)',
          faint: 'rgb(var(--ink-faint) / <alpha-value>)',
        },
        brass: {
          DEFAULT: 'rgb(var(--brass) / <alpha-value>)',
          deep: 'rgb(var(--brass-deep) / <alpha-value>)',
        },
        olive: 'rgb(var(--olive) / <alpha-value>)',
        good: 'rgb(var(--good) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        crit: 'rgb(var(--crit) / <alpha-value>)',
        // Category hues (see --hue-* in styles/index.css): hue-teal, text-hue-teal-ink, …
        hue: {
          pink: { DEFAULT: 'rgb(var(--hue-pink) / <alpha-value>)', ink: 'rgb(var(--hue-pink-ink) / <alpha-value>)' },
          teal: { DEFAULT: 'rgb(var(--hue-teal) / <alpha-value>)', ink: 'rgb(var(--hue-teal-ink) / <alpha-value>)' },
          orange: { DEFAULT: 'rgb(var(--hue-orange) / <alpha-value>)', ink: 'rgb(var(--hue-orange-ink) / <alpha-value>)' },
          indigo: { DEFAULT: 'rgb(var(--hue-indigo) / <alpha-value>)', ink: 'rgb(var(--hue-indigo-ink) / <alpha-value>)' },
          green: { DEFAULT: 'rgb(var(--hue-green) / <alpha-value>)', ink: 'rgb(var(--hue-green-ink) / <alpha-value>)' },
          amber: { DEFAULT: 'rgb(var(--hue-amber) / <alpha-value>)', ink: 'rgb(var(--hue-amber-ink) / <alpha-value>)' },
          violet: { DEFAULT: 'rgb(var(--hue-violet) / <alpha-value>)', ink: 'rgb(var(--hue-violet-ink) / <alpha-value>)' },
          sky: { DEFAULT: 'rgb(var(--hue-sky) / <alpha-value>)', ink: 'rgb(var(--hue-sky-ink) / <alpha-value>)' },
        },
        nav: {
          DEFAULT: 'rgb(var(--nav) / <alpha-value>)',
          hover: 'rgb(var(--nav-hover) / <alpha-value>)',
          text: 'rgb(var(--nav-text) / <alpha-value>)',
          muted: 'rgb(var(--nav-muted) / <alpha-value>)',
        },
      },
      fontFamily: {
        // Houzz Pro uses a single clean grotesque everywhere; Inter is the closest open font.
        display: ['Inter', 'Helvetica Neue', 'Arial', 'sans-serif'],
        sans: ['Inter', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['Inter', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,23,42,.04), 0 2px 8px rgba(15,23,42,.05)',
        pop: '0 12px 32px rgba(15,23,42,.16)',
      },
      borderRadius: {
        lg: '8px',
        xl: '12px',
      },
    },
  },
  plugins: [],
};
