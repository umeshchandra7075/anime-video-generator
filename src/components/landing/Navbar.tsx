import Link from "next/link";

export function Navbar() {
  return (
    <header className="sticky top-0 z-30 border-b border-ink-700/60 bg-ink-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="font-display text-xl italic tracking-tight text-paper">
          Anime Video Generator
        </Link>
        <nav className="hidden items-center gap-8 text-sm text-paper/70 md:flex">
          <a href="#how-it-works" className="hover:text-paper">
            How it works
          </a>
          <a href="#features" className="hover:text-paper">
            Features
          </a>
          <a href="#pricing" className="hover:text-paper">
            Pricing
          </a>
          <a href="#faq" className="hover:text-paper">
            FAQ
          </a>
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-sm text-paper/70 hover:text-paper">
            Log in
          </Link>
          <Link
            href="/register"
            className="rounded-full bg-lantern-500 px-4 py-2 text-sm font-semibold text-ink-950 transition hover:bg-lantern-400"
          >
            Create video
          </Link>
        </div>
      </div>
    </header>
  );
}
