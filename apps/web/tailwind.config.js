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
        card: '0 1px 2px rgba(16,24,32,.04), 0 1px 3px rgba(16,24,32,.06)',
        pop: '0 8px 24px rgba(16,24,32,.12)',
      },
      borderRadius: {
        lg: '6px',
        xl: '8px',
      },
    },
  },
  plugins: [],
};
