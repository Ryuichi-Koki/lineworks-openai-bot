import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "スグ税 | Apex Brain税理士法人",
    template: "%s | スグ税",
  },
  description: "スグ税の会員サービス・規程情報",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
