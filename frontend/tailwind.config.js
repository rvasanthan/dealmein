/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        teal: { 50: '#eaf5f5', 100: '#cfe7e8', 200: '#9fcfd1', 600: '#177a80', 700: '#0f5e63', 800: '#0b4a4f', 900: '#083a3e' },
        cream: { DEFAULT: '#fbf7f0', 100: '#f4ede0', 200: '#e8dfce' },
        accent: { 400: '#f6a04d', 500: '#f28c28', 600: '#d9730f', 700: '#a85709' },
        ink: { DEFAULT: '#1d2b2c', soft: '#4b5b5c' },
      },
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'] },
    },
  },
  plugins: [],
}
