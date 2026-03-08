import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Colloquy of Mobiles VS Phygital",
  description: "WebSerial testing dashboard for the Colloquy of Mobiles Virtual Simulation Phygital firmware"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
