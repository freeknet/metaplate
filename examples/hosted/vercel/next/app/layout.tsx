import type { Metadata } from "next";
import type { ReactNode } from "react";
import { origin } from "../lib/origin";

export const metadata: Metadata = { metadataBase: new URL(origin) };

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
