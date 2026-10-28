import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ScreenForge",
  description: "Operator screens on request: describe what you need to watch and get a live, validated, read-only HMI screen.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full">{children}</body>
    </html>
  );
}
