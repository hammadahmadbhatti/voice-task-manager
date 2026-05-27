import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voice Task Manager",
  description: "Manage your day by talking to it."
};

// Root layout — locale-aware layout lives at /[locale]/layout.tsx.
export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
