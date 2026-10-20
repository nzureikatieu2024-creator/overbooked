import type { Metadata } from "next";
import { Inter, Instrument_Serif } from "next/font/google";
import Link from "next/link";
import LogoutButton from "@/components/LogoutButton";
import { createClient } from "@/lib/supabase/server";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-serif" });

export const metadata: Metadata = {
  title: "Overbooked — study planning that keeps up with you",
  description:
    "Overbooked automatically plans your studying around your life — and replans when you fall behind.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <html lang="en" className={`${inter.variable} ${serif.variable}`}>
      <body>
        <header className="site-header">
          <div className="container">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true">
                <span />
              </span>
              Overbooked
            </Link>
            <nav className="nav" aria-label="Main">
              {user ? (
                <>
                  <Link href="/app" className="nav-link">
                    Planner
                  </Link>
                  <LogoutButton />
                </>
              ) : (
                <Link href="/login" className="nav-link">
                  Log in
                </Link>
              )}
            </nav>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
