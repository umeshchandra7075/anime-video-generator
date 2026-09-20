import type { Metadata } from "next";
import "@/styles/globals.css";
import { ToastProvider } from "@/components/ui/Toast";

export const metadata: Metadata = {
  title: "Anime Video Generator",
  description: "Turn your stories into cinematic anime videos with AI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-body bg-ink-950 text-paper antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
