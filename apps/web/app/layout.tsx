import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Solutions Platform",
  description: "Multi-tenant modular platform",
};

// Founder feedback (2026-07-12, "doesn't come out very well on phone/
// tablet"): there was NO viewport meta tag anywhere in the app — every
// mobile browser was rendering the page at desktop width and letting the
// user pinch-zoom, regardless of any responsive CSS. This is the platform-
// wide foundation everything else in the responsive pass builds on.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: browser extensions (password managers, Grammarly)
    // inject attributes into <html>/<body> before React hydrates, triggering a
    // harmless dev-mode mismatch warning. This silences it for these two elements
    // only — real hydration bugs inside the tree still warn.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body suppressHydrationWarning className="min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}
