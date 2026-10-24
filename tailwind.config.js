/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#176B5B', hover: '#125548', soft: '#E6F1EE', ink: '#0F4A3F' },
        page: '#F6F8F5',
        surface: { DEFAULT: '#FFFFFF', muted: '#F0F3F0', sunken: '#EAEFEB' },
        line: { DEFAULT: '#DDE4DF', strong: '#C5D0C9' },
        ink: { DEFAULT: '#17211D', soft: '#5D6963', faint: '#6E7A74' },
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
