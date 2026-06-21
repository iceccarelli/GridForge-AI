import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Base — deep navy / near-black engineering canvas
        ink: "#070B14",
        panel: "#0E1524",
        "panel-2": "#131C2E",
        line: "#1E2942",
        // Signal system — meaning, not decoration
        power: "#00E5FF", // on-site power / live / good
        queue: "#FFB020", // grid queue / delay / warning
        verified: "#34D399", // genuinely operational / confirmed
        flag: "#F87171", // cost / risk
        // Text
        ghost: "#F5F7FA",
        mute: "#8A94A6",
        faint: "#5A6478",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": {
          from: { transform: "translateY(20px)", opacity: "0" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
        "scale-in": {
          from: { transform: "scale(0.96)", opacity: "0" },
          to: { transform: "scale(1)", opacity: "1" },
        },
        "trace": {
          from: { strokeDashoffset: "1000" },
          to: { strokeDashoffset: "0" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.5s ease-out",
        "slide-up": "slide-up 0.6s cubic-bezier(0.23, 1, 0.32, 1)",
        "scale-in": "scale-in 0.35s cubic-bezier(0.23, 1, 0.32, 1)",
      },
    },
  },
  plugins: [],
};
export default config;
