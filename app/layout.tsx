import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Formula 1 Lab · Edmund Hong",
  description:
    "Explore Formula 1 fastest laps, telemetry and race pace. Independent, post-session analysis from 2026 onward.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{const t=localStorage.getItem('f1-theme');document.documentElement.dataset.theme=t||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
