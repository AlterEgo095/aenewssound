import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AENEWS SOUND — Streaming musical congolais",
  description:
    "Plateforme audio distribuée : rumba, ndombolo, gospel et plus — streaming adaptatif, offline premium, paiements mobile money.",
  keywords: ["AENEWS SOUND", "musique congolaise", "rumba", "streaming", "Kinshasa"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "AENEWS SOUND",
    description: "Le son du Congo, partout, même hors ligne.",
    siteName: "AENEWS SOUND",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
