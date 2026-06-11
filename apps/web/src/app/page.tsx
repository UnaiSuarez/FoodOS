import { SiteHeader } from "@/components/landing/SiteHeader";
import { Hero } from "@/components/landing/Hero";
import { Ticker } from "@/components/landing/Ticker";
import { Features, Problem } from "@/components/landing/Features";
import { Showcase } from "@/components/landing/Showcase";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { MascotsSection } from "@/components/landing/MascotsSection";
import { DownloadSection } from "@/components/landing/DownloadSection";
import { LoginSection } from "@/components/landing/LoginSection";
import { SiteFooter } from "@/components/landing/SiteFooter";
import "./landing.css";

export default function LandingPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <Ticker />
        <Problem />
        <Features />
        <Showcase />
        <HowItWorks />
        <MascotsSection />
        <DownloadSection />
        <LoginSection />
      </main>
      <SiteFooter />
    </>
  );
}
