/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#1e3a8a', hover: '#172e6e', soft: '#E8EDF8', ink: '#172554' },
        page: '#F3F5F9',
        surface: { DEFAULT: '#FFFFFF', muted: '#EEF1F6', sunken: '#E6EAF2' },
        line: { DEFAULT: '#D9DFE8', strong: '#C4CCDA' },
        ink: { DEFAULT: '#0F172A', soft: '#475569', faint: '#64748B' },
        accent: { DEFAULT: '#236B9A', soft: '#E7F0F7' },
        success: { DEFAULT: '#168568', soft: '#E5F4EE' },
        warning: { DEFAULT: '#946200', soft: '#FBF1DC' },
        danger: { DEFAULT: '#B42318', soft: '#FCE9E7' },
        info: { DEFAULT: '#52616B', soft: '#EDF0F2' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      borderRadius: { card: '12px' },
      boxShadow: {
        card: '0 1px 2px rgba(23,33,29,0.04)',
        lift: '0 4px 12px rgba(23,33,29,0.08)',
        pop: '0 12px 32px rgba(23,33,29,0.16)',
      },
      fontSize: { '2xs': ['0.75rem', '1rem'] },
    },
  },
  plugins: [],
};
