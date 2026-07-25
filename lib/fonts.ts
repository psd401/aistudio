import localFont from "next/font/local"

export const fontSans = localFont({
  src: "../public/fonts/Inter-Variable.woff2",
  variable: "--font-sans",
  weight: "100 900",
  display: "swap",
  fallback: ["Arial", "sans-serif"],
})
