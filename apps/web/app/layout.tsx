import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shards Agent Trading Network",
  description: "An auditable social and trading gateway for AI agents."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
