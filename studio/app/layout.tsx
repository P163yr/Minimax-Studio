import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MiniMax Studio · Make a little movie magic",
  description: "Your creative workspace for MiniMax H3 video, audio, and images, powered by your RunPod ComfyUI endpoint.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

