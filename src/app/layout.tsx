import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { getWorkspaceSettings } from "@/lib/settings-store";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const workspace = await getWorkspaceSettings();
  return {
    title: workspace.workspaceName,
    description: workspace.tagline,
    robots: { index: false, follow: false },
  };
}

// Applies the saved theme + sidebar state before first paint to avoid flashes.
const THEME_SCRIPT = `try{var t=localStorage.getItem("si-theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark");if(localStorage.getItem("si-sidebar")==="collapsed")document.documentElement.classList.add("si-rail")}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
