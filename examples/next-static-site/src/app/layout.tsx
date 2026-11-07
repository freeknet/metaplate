// src/app/layout.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE } from "../lib/site";

export const metadata: Metadata = {
  // Resolves the relative `canonical` and `og:url` that pages state.
  metadataBase: new URL(SITE.origin),
  title: { default: SITE.name, template: `%s · ${SITE.name}` },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
