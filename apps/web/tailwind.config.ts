import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/hooks/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        // Urban-Ground-inspired warm palette
        ink: "#0a0a0a",
        cream: "#f7f3ec",
        accent: "#e85d1f",
        muted: "#6b7280"
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "Inter", "sans-serif"]
      },
      animation: {
        breathe: "breathe 3s ease-in-out infinite",
        pulse: "pulse 1.2s ease-in-out infinite"
      },
      keyframes: {
        breathe: {
          "0%, 100%": { transform: "scale(1)", opacity: "0.9" },
          "50%": { transform: "scale(1.05)", opacity: "1" }
        }
      }
    }
  },
  plugins: []
};

export default config;
