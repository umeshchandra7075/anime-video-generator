import { Navbar } from "@/components/landing/Navbar";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Features } from "@/components/landing/Features";
import { LanguagesAndStyles } from "@/components/landing/LanguagesAndStyles";
import { Pricing } from "@/components/landing/Pricing";
import { Faq } from "@/components/landing/Faq";
import { FinalCta, Footer } from "@/components/landing/FinalCta";

export default function LandingPage() {
  return (
    <main>
      <Navbar />
      <Hero />
      <HowItWorks />
      <Features />
      <LanguagesAndStyles />
      <Pricing />
      <Faq />
      <FinalCta />
      <Footer />
    </main>
  );
}
