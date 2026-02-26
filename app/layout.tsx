import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ThemeProvider from "./components/ThemeProvider";
import ErrorBoundary from "./components/ErrorBoundary";
import AuthGuard from "./components/AuthGuard";
import { AuthProvider } from "./providers/AuthProvider";
import { SocketProvider } from "./providers/SocketProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Shield - WhatsApp Triage Assistant",
  description: "WhatsApp triage assistant dashboard",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased max-w-[100vw] overflow-x-hidden`}
      >
        <ErrorBoundary>
          <ThemeProvider>
            <AuthProvider>
              <SocketProvider>
                <AuthGuard>{children}</AuthGuard>
              </SocketProvider>
            </AuthProvider>
          </ThemeProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
