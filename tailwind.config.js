/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0E0F17",
          900: "#12131F",
          800: "#191B2A",
          700: "#232538",
          600: "#31344C",
        },
        paper: "#F3EFE6",
        lantern: {
          400: "#F2B25C",
          500: "#E8A33D",
          600: "#C97F22",
        },
        moon: {
          300: "#9BF0E8",
          400: "#6FE7DD",
          500: "#48C9BE",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "serif"],
        body: ["var(--font-body)", "sans-serif"],
      },
      backgroundImage: {
        "lantern-glow": "radial-gradient(circle at 30% 20%, rgba(232,163,61,0.35), transparent 55%)",
        "moon-glow": "radial-gradient(circle at 80% 70%, rgba(111,231,221,0.25), transparent 55%)",
      },
    },
  },
  plugins: [],
};
