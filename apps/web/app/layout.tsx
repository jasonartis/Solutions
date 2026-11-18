import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { BootFlag } from "@/components/boot-flag";

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
  // Home Screen app on iPhone (2026-11-18): opens full-screen, without
  // Safari's bars, under the name "Solutions". Next emits only the newer
  // "mobile-web-app-capable" tag; iOS 15 needs the Apple-prefixed one, hence
  // `other`. The manifest (app/manifest.ts) says the same for other phones.
  appleWebApp: { capable: true, title: "Solutions", statusBarStyle: "default" },
  other: { "apple-mobile-web-app-capable": "yes" },
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

// Early error display (diagnostic, 2026-11-18). Old browsers (an iPhone 7 on
// iOS 15) can fail to run our JavaScript with no visible sign: the page looks
// fine but nothing responds. This script is deliberately written in plain
// old ES5 (var + function only) so even those browsers can run it. It
// remembers any script errors, and about 6 seconds after load, IF the app has
// not set window.__spBooted (see components/boot-flag.tsx), it shows them in a
// red box so they can be screenshotted. A browser that boots normally never
// sees the box. Text is inserted with textContent only, never as HTML.
const EARLY_ERROR_SCRIPT = `
(function () {
  var errors = [];
  function add(text) {
    if (errors.length < 5) {
      errors.push(String(text).slice(0, 300));
    }
  }
  // true = capture phase, so failures to LOAD a script file are caught too.
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== window && (t.src || t.href)) {
      add('Failed to load: ' + (t.src || t.href));
    } else {
      add((e && e.message) + ' at ' + (e && e.filename) + ':' + (e && e.lineno) + ':' + (e && e.colno));
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    add('Unhandled promise rejection: ' + (r && r.message ? r.message : r));
  });
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (window.__spBooted) return;
      var box = document.createElement('div');
      box.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#b91c1c;color:#fff;padding:12px;font:12px/1.4 monospace;max-height:50%;overflow:auto;word-break:break-all');
      var lines = errors.length
        ? errors
        : ["The app's scripts did not start and no error was reported"];
      box.textContent = 'App failed to start: ' + lines.join('  ||  ');
      document.body.appendChild(box);
    }, 6000);
  });
})();
`;

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
      <head>
        <script dangerouslySetInnerHTML={{ __html: EARLY_ERROR_SCRIPT }} />
      </head>
      <body suppressHydrationWarning className="min-h-full flex flex-col">
        <BootFlag />
        {children}
      </body>
    </html>
  );
}
