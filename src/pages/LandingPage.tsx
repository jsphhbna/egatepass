import { useEffect, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  ShieldCheck,
  Smartphone,
  CheckCircle2,
  ArrowRight,
  FileText,
  UserCheck,
  ScanLine,
  Lock,
  Clock,
  HelpCircle,
  MapPin,
  Camera,
  CreditCard,
  QrCode,
  User,
} from 'lucide-react';
import { LANDING_CONTENT } from '@/content/landing';

const processIcons = [FileText, Camera, QrCode, UserCheck, ScanLine];
const needIcons = [User, Camera, CreditCard, Clock];
const verificationIcons = [ShieldCheck, UserCheck, ScanLine, Clock];

export function LandingPage() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    function handleScroll() {
      setIsScrolled(window.scrollY > 20);
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  function scrollToSection(event: MouseEvent<HTMLAnchorElement>, target: string) {
    event.preventDefault();
    const section = document.querySelector(target);
    if (!section) return;
    section.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
    window.history.pushState(null, '', target);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-white text-[var(--color-text-primary)] antialiased">
      {/* Skip to main content link for keyboard users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[var(--color-brand)] focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-white focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2"
      >
        Skip to main content
      </a>

      {/* ============================================================
          FIX GROUP 2: REFINED INSTITUTIONAL HEADER (WHITE CANVAS)
          ============================================================ */}
      <header
        className={`sticky top-0 z-50 border-b bg-white/95 backdrop-blur-md transition-shadow ${
          isScrolled ? 'border-gray-200 shadow-sm' : 'border-gray-100'
        }`}
      >
        <div className="mx-auto flex min-h-16 max-w-7xl 2xl:max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8 xl:px-12 2xl:px-16">
          <Link
            to="/"
            className="flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a31d1d]"
          >
            <img src="/earist-logo.png" alt="EARIST seal" className="h-10 w-10 shrink-0 object-contain" />
            <span className="min-w-0">
              <span className="block truncate text-base sm:text-lg font-black tracking-tight text-[#700f14]">
                {LANDING_CONTENT.header.title}
              </span>
              <span className="hidden truncate text-[10px] sm:text-xs font-bold uppercase tracking-wider text-gray-500 sm:block">
                {LANDING_CONTENT.header.subtitle}
              </span>
            </span>
          </Link>

          <div className="flex items-center gap-4 lg:gap-8">
            <nav aria-label="Landing page sections" className="hidden items-center gap-7 lg:flex">
              {LANDING_CONTENT.header.navLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={(event) => scrollToSection(event, link.href)}
                  className="rounded-sm text-sm font-semibold text-gray-700 transition-colors hover:text-[#700f14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a31d1d]"
                >
                  {link.label}
                </a>
              ))}
            </nav>
            <Link
              to="/get-pass"
              className="inline-flex min-h-10 items-center justify-center rounded-full bg-[#a31d1d] hover:bg-[#850e12] px-5 sm:px-6 text-xs sm:text-sm font-bold text-white shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a31d1d] focus-visible:ring-offset-2"
            >
              <span className="sm:hidden">Get Pass</span>
              <span className="hidden sm:inline">Get Your Gate Pass</span>
            </Link>
          </div>
        </div>
      </header>

      <main id="main-content">
        {/* ============================================================
            FIX GROUP 1 & 3: HERO SECTION (LIGHT CANVAS + RED COMPOSITION)
            ============================================================ */}
        <section aria-label="Introduction" className="relative overflow-hidden bg-white px-4 py-12 sm:px-6 sm:py-16 lg:px-8 lg:py-20 xl:px-12 2xl:px-16 2xl:py-24">
          {/* Subtle architectural campus watermark behind left text / center */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 h-full w-full opacity-[0.04] sm:opacity-[0.05]"
            style={{
              backgroundImage: 'radial-gradient(#700f14 1px, transparent 1px)',
              backgroundSize: '24px 24px',
            }}
          />
          <CampusWatermark />

          <div className="relative mx-auto grid max-w-7xl 2xl:max-w-[1600px] items-center gap-10 lg:grid-cols-[1.1fr_0.9fr] xl:grid-cols-[1.05fr_0.95fr] lg:gap-12 xl:gap-16">
            {/* Left Column: Institutional Copy matching Reference */}
            <div className="max-w-xl xl:max-w-2xl">
              {/* Eyebrow - Clean, bold red uppercase without SaaS bubble pill */}
              <p className="text-xs sm:text-sm font-black uppercase tracking-[0.14em] text-[#a31d1d]">
                {LANDING_CONTENT.hero.eyebrow}
              </p>

              {/* Dominant Title in dark EARIST maroon */}
              <h1 className="mt-2.5 sm:mt-3 text-5xl sm:text-6xl lg:text-[4rem] xl:text-[4.25rem] font-black tracking-tight text-[#700f14] leading-[1.05]">
                {LANDING_CONTENT.hero.title}
              </h1>

              {/* Subheading in dark charcoal/near-black */}
              <p className="mt-3.5 sm:mt-4 text-xl sm:text-2xl font-bold leading-snug text-[#111827] max-w-xl">
                {LANDING_CONTENT.hero.subtitle}
              </p>

              {/* Supporting explanation in medium gray */}
              <p className="mt-3 sm:mt-4 text-sm sm:text-base leading-relaxed text-[#4b5563] max-w-lg">
                {LANDING_CONTENT.hero.supportingText}
              </p>

              {/* Action Buttons */}
              <div className="mt-7 sm:mt-8 flex flex-col gap-3.5 sm:flex-row">
                <Link
                  to="/get-pass"
                  className="inline-flex min-h-12 items-center justify-center rounded-xl bg-[#a31d1d] hover:bg-[#850e12] px-7 text-sm sm:text-base font-bold text-white shadow-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a31d1d] focus-visible:ring-offset-2"
                >
                  Get Your Gate Pass
                  <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Link>
                <a
                  href="#how-it-works"
                  onClick={(event) => scrollToSection(event, '#how-it-works')}
                  className="inline-flex min-h-12 items-center justify-center rounded-xl border border-gray-300 bg-white hover:bg-gray-50 px-6 text-sm sm:text-base font-bold text-[#374151] shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a31d1d]"
                >
                  How It Works
                </a>
              </div>

              {/* Trust Indicators: 3 horizontal columns with red outline icons */}
              <div className="mt-8 sm:mt-10 flex flex-wrap items-center gap-6 sm:gap-8 pt-4 border-t border-gray-100">
                <div className="flex items-center gap-3">
                  <User className="h-6 w-6 shrink-0 text-[#a31d1d] stroke-[1.75]" aria-hidden="true" />
                  <div className="text-xs sm:text-sm font-semibold text-[#374151] leading-tight">
                    <span>No visitor</span><br /><span>account needed</span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Smartphone className="h-6 w-6 shrink-0 text-[#a31d1d] stroke-[1.75]" aria-hidden="true" />
                  <div className="text-xs sm:text-sm font-semibold text-[#374151] leading-tight">
                    <span>Works on mobile</span><br /><span>or kiosk</span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <ShieldCheck className="h-6 w-6 shrink-0 text-[#a31d1d] stroke-[1.75]" aria-hidden="true" />
                  <div className="text-xs sm:text-sm font-semibold text-[#374151] leading-tight">
                    <span>Secure and</span><br /><span>privacy-focused</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Hero Artwork (Red Shape Anchor + Phone + Physical Pass) */}
            <HeroArtwork />
          </div>
        </section>

        {/* ============================================================
            FIX GROUP 4: "HOW E-GATEPASS WORKS" PROCESS TIMELINE
            ============================================================ */}
        <section
          id="how-it-works"
          aria-labelledby="process-heading"
          className="scroll-mt-20 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24 xl:px-12 2xl:px-16 border-t border-gray-100"
        >
          <div className="mx-auto max-w-7xl 2xl:max-w-[1600px]">
            <SectionHeading
              id="process-heading"
              eyebrow="Visitor process"
              title={LANDING_CONTENT.process.heading}
              description={LANDING_CONTENT.process.intro}
              centered
            />

            <ol className="relative mt-12 grid gap-6 md:grid-cols-5 md:gap-4 2xl:gap-6">
              {/* Connecting line on desktop */}
              <div
                aria-hidden="true"
                className="absolute bottom-10 left-6 top-10 w-0.5 bg-[var(--color-accent)]/60 md:bottom-auto md:left-[10%] md:right-[10%] md:top-6 md:h-0.5 md:w-auto"
              />

              {LANDING_CONTENT.process.steps.map((step, index) => {
                const Icon = processIcons[index] ?? FileText;
                return (
                  <li
                    key={step.title}
                    className="relative flex gap-5 rounded-xl border border-[var(--color-border)]/60 bg-white p-5 md:flex-col md:items-center md:border-transparent md:p-2 md:text-center"
                  >
                    <div className="relative z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--color-institutional)] text-base font-extrabold text-white ring-4 ring-white shadow-sm">
                      {index + 1}
                    </div>
                    <div className="pt-1 md:pt-2">
                      <div className="mb-2 hidden h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-brand-light)] text-[var(--color-institutional)] md:mx-auto md:flex">
                        <Icon className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <h3 className="text-base font-bold text-[var(--color-text-primary)]">{step.title}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">{step.text}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        {/* ============================================================
            FIX GROUP 5: "WHAT YOU NEED" SECTION
            ============================================================ */}
        <section
          id="what-you-need"
          aria-labelledby="needs-heading"
          className="scroll-mt-20 bg-[var(--color-canvas)] px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24 xl:px-12 2xl:px-16"
        >
          <div className="mx-auto max-w-7xl 2xl:max-w-[1600px]">
            <SectionHeading
              id="needs-heading"
              eyebrow="Before you begin"
              title={LANDING_CONTENT.needs.heading}
              description={LANDING_CONTENT.needs.intro}
            />

            <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4 2xl:gap-8">
              {LANDING_CONTENT.needs.items.map((item, index) => {
                const Icon = needIcons[index] ?? FileText;
                return (
                  <article
                    key={item.title}
                    className="flex flex-col rounded-xl border border-[var(--color-border)] bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
                  >
                    <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--color-brand-light)] text-[var(--color-institutional)]">
                      <Icon className="h-6 w-6" aria-hidden="true" />
                    </div>
                    <h3 className="text-lg font-bold text-[var(--color-text-primary)]">{item.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">{item.text}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* ============================================================
            FIX GROUP 6: ASYMMETRIC INSTITUTIONAL VERIFICATION SECTION
            ============================================================ */}
        <section
          aria-labelledby="verification-heading"
          className="bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24 xl:px-12 2xl:px-16"
        >
          <div className="mx-auto grid max-w-7xl 2xl:max-w-[1600px] gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-stretch">
            {/* EARIST Red Emphasis Panel */}
            <div className="relative flex flex-col justify-between overflow-hidden rounded-2xl bg-[var(--color-institutional)] p-8 text-white shadow-sm sm:p-10">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-10 -right-10 h-64 w-64 rounded-full opacity-10"
                style={{
                  backgroundImage: 'url(/earist-logo.png)',
                  backgroundSize: 'contain',
                  backgroundRepeat: 'no-repeat',
                }}
              />
              <div>
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-white/10 text-[var(--color-accent)]">
                  <ShieldCheck className="h-7 w-7" aria-hidden="true" />
                </div>
                <h2 id="verification-heading" className="mt-6 text-3xl font-extrabold tracking-tight sm:text-4xl">
                  {LANDING_CONTENT.verification.heading}
                </h2>
                <p className="mt-4 text-base leading-relaxed text-white/80">
                  {LANDING_CONTENT.verification.intro}
                </p>
              </div>

              <div className="mt-8 border-t border-white/20 pt-6">
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-accent)]">
                  Campus Protocol Standard
                </p>
                <p className="mt-1 text-sm text-white/75">
                  Controlled entry ensures safety, integrity, and swift roll call verification for the entire academic community.
                </p>
              </div>
            </div>

            {/* 4 Supporting Verification Cards */}
            <div className="grid gap-5 sm:grid-cols-2">
              {LANDING_CONTENT.verification.points.map((point, index) => {
                const Icon = verificationIcons[index] ?? ShieldCheck;
                return (
                  <article
                    key={point.title}
                    className="flex flex-col justify-between rounded-2xl border border-[var(--color-border)] bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
                  >
                    <div>
                      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-brand-light)] text-[var(--color-institutional)]">
                        <Icon className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <h3 className="text-lg font-bold text-[var(--color-text-primary)]">{point.title}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">{point.text}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* ============================================================
            FIX GROUP 7: RESPONSIBLE DATA USE / PRIVACY AND SAFETY
            ============================================================ */}
        <section
          id="privacy"
          aria-labelledby="privacy-heading"
          className="scroll-mt-20 bg-[var(--color-canvas)] px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24 xl:px-12 2xl:px-16"
        >
          <div className="mx-auto max-w-7xl 2xl:max-w-[1600px]">
            <div className="rounded-2xl border border-[var(--color-border)] bg-white p-8 shadow-sm sm:p-10 lg:p-12">
              <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-[var(--color-institutional)]">
                    Responsible data use
                  </p>
                  <h2 id="privacy-heading" className="mt-2 text-2xl font-extrabold tracking-tight text-[var(--color-text-primary)] sm:text-3xl">
                    {LANDING_CONTENT.privacy.heading}
                  </h2>
                  <p className="mt-3 text-sm leading-relaxed text-[var(--color-text-secondary)]">
                    {LANDING_CONTENT.privacy.intro}
                  </p>
                  <div className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[var(--color-brand-light)] px-3.5 py-2 text-xs font-bold text-[var(--color-institutional)]">
                    <Lock className="h-4 w-4" aria-hidden="true" />
                    <span>{LANDING_CONTENT.privacy.law}</span>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  {LANDING_CONTENT.privacy.points.map((point) => {
                    const [title, desc] = point.split(': ');
                    return (
                      <div key={title} className="rounded-xl border border-[var(--color-border)]/60 bg-[var(--color-canvas)]/40 p-4">
                        <div className="flex items-center gap-2 font-bold text-[var(--color-text-primary)]">
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden="true" />
                          <span>{title}</span>
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-secondary)]">
                          {desc}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============================================================
            FIX GROUP 8: ACCESSIBLE FAQ ACCORDION
            ============================================================ */}
        <section
          id="faq"
          aria-labelledby="faq-heading"
          className="scroll-mt-20 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24 xl:px-12 2xl:px-16"
        >
          <div className="mx-auto max-w-3xl">
            <SectionHeading
              id="faq-heading"
              eyebrow="Clarifications"
              title={LANDING_CONTENT.faq.heading}
              centered
            />

            <div className="mt-10 space-y-3.5">
              {LANDING_CONTENT.faq.items.map((item, idx) => (
                <details
                  key={idx}
                  className="group rounded-xl border border-[var(--color-border)] bg-white p-5 transition-colors open:bg-[var(--color-canvas-subtle)] open:border-[var(--color-brand)]/40 hover:border-gray-300"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between text-base font-bold text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]">
                    <span className="flex items-center gap-3">
                      <HelpCircle className="h-4 w-4 shrink-0 text-[var(--color-institutional)]" aria-hidden="true" />
                      <span>{item.q}</span>
                    </span>
                    <span className="ml-4 shrink-0 text-[var(--color-text-muted)] transition-transform duration-200 group-open:rotate-180">
                      ▼
                    </span>
                  </summary>
                  <p className="mt-3 pl-7 text-sm leading-relaxed text-[var(--color-text-secondary)]">
                    {item.a}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ============================================================
            FIX GROUP 9: FINAL INSTITUTIONAL VISITOR CTA
            ============================================================ */}
        <section
          aria-labelledby="final-cta-heading"
          className="bg-[var(--color-institutional)] px-4 py-16 text-center text-white sm:px-6 sm:py-20 lg:px-8 xl:px-12 2xl:px-16"
        >
          <div className="mx-auto max-w-3xl">
            <h2 id="final-cta-heading" className="text-3xl font-extrabold tracking-tight sm:text-4xl">
              {LANDING_CONTENT.finalCta.heading}
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-white/80">
              {LANDING_CONTENT.finalCta.text}
            </p>
            <div className="mt-8 flex justify-center">
              <Link
                to="/get-pass"
                className="inline-flex min-h-12 items-center justify-center rounded-xl bg-[var(--color-action)] px-8 text-base font-bold text-white shadow-lg transition-colors hover:bg-[var(--color-action-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-institutional)]"
              >
                Get Your Gate Pass
                <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* ============================================================
          FIX GROUP 10: INSTITUTIONAL FOOTER
          ============================================================ */}
      <InstitutionalFooter />
    </div>
  );
}

{/* ============================================================
    HERO VISUAL ARTWORK (PRIMARY VISUAL REFERENCE TARGET)
    - Deep red circular backdrop with embossed EARIST seal
    - Smartphone mockup with digital QR pass in foreground
    - Physical pass card slightly tilted in background overlap
    - Neoclassical EARIST campus architectural illustration
    ============================================================ */}
function HeroArtwork() {
  return (
    <aside aria-label="Digital and physical gate pass preview" className="relative mx-auto w-full max-w-lg lg:max-w-none lg:mx-0 select-none">
      <div className="relative mx-auto flex items-center justify-center lg:justify-end py-6 sm:py-8 lg:py-10 min-h-[460px] sm:min-h-[520px]">
        {/* Large restrained EARIST maroon circle backdrop */}
        <div
          aria-hidden="true"
          className="absolute right-0 sm:right-6 lg:right-2 xl:right-6 top-1/2 -translate-y-1/2 w-[340px] h-[340px] sm:w-[440px] sm:h-[440px] lg:w-[470px] lg:h-[470px] xl:w-[530px] xl:h-[530px] rounded-full bg-[#700f14] shadow-2xl overflow-hidden flex items-center justify-center"
        >
          {/* Embossed / tonal EARIST seal watermark */}
          <div
            className="absolute inset-0 bg-contain bg-center bg-no-repeat opacity-[0.22] mix-blend-luminosity transform scale-90 pointer-events-none"
            style={{ backgroundImage: 'url(/earist-logo.png)' }}
          />
          {/* Subtle radial depth */}
          <div className="absolute inset-0 bg-radial from-transparent via-[#700f14]/20 to-[#4a080c]/50" />
        </div>

        {/* Sweeping red curved tail at bottom-right corner (from reference image) */}
        <div
          aria-hidden="true"
          className="absolute -right-8 -bottom-12 w-28 h-56 sm:w-36 sm:h-72 bg-[#700f14] rounded-full opacity-90 blur-[1px] pointer-events-none hidden lg:block"
        />

        {/* Composition Container holding Physical Pass & Phone Overlap */}
        <div className="relative z-10 flex items-center justify-center w-full max-w-[480px] sm:max-w-[540px] lg:max-w-[580px] xl:max-w-[620px]">
          {/* --------------------------------------------------------
              PHYSICAL VISITOR PASS (Offset behind to the right, tilted)
              -------------------------------------------------------- */}
          <div
            aria-hidden="true"
            className="absolute right-0 sm:right-2 lg:-right-2 xl:right-0 top-1 sm:top-3 w-[205px] sm:w-[240px] lg:w-[250px] rounded-2xl bg-white p-3.5 sm:p-4 shadow-2xl border border-gray-100/90 z-10 transform rotate-[8deg] sm:rotate-[9deg] text-gray-900 transition-transform"
          >
            {/* Header: Seal + E-GatePass / VISITOR PASS */}
            <div className="flex items-center gap-2 border-b border-gray-100 pb-2.5">
              <img src="/earist-logo.png" alt="" className="h-7 w-7 object-contain" />
              <div>
                <p className="text-xs sm:text-sm font-black text-gray-900 leading-none">
                  E-GatePass
                </p>
                <p className="text-[9px] sm:text-[10px] font-bold text-[#b91c1c] tracking-wider uppercase mt-0.5">
                  VISITOR PASS
                </p>
              </div>
            </div>

            {/* QR Code graphic */}
            <div className="my-2.5 sm:my-3 flex justify-center">
              <div className="p-1 rounded-lg bg-white border border-gray-100 shadow-xs">
                <VectorQrCode className="h-28 w-28 sm:h-32 sm:w-32" />
              </div>
            </div>

            {/* Fictional Sample Visitor Data */}
            <div className="text-center">
              <p className="text-xs sm:text-sm font-black text-gray-900 tracking-tight">
                Sample Visitor
              </p>
              <p className="text-[10px] sm:text-[11px] font-semibold text-gray-500 mt-0.5">
                Oct 22, 2026
              </p>
              <p className="text-[10px] sm:text-[11px] text-gray-500">
                Main Campus Gate
              </p>
            </div>

            {/* EARIST Classical Building Facade Illustration */}
            <div className="mt-3 overflow-hidden rounded-lg border border-gray-100 bg-gray-50">
              <BuildingFacadeGraphic />
            </div>

            <div className="sr-only">
              EARIST Security Official Visitor Pass
            </div>
          </div>

          {/* --------------------------------------------------------
              SMARTPHONE MOCKUP (Foreground on left, overlapping pass)
              -------------------------------------------------------- */}
          <div className="relative z-20 mr-16 sm:mr-24 lg:mr-28 xl:mr-32 w-[210px] sm:w-[240px] lg:w-[250px] rounded-[2.5rem] sm:rounded-[2.75rem] border-[6px] sm:border-[7px] border-slate-900 bg-slate-900 p-2 shadow-2xl ring-1 ring-black/10">
            {/* Top speaker / camera Dynamic Island */}
            <div className="mx-auto h-3.5 w-16 sm:h-4 sm:w-20 rounded-full bg-black mb-1.5" />

            {/* Phone Screen Canvas */}
            <div className="overflow-hidden rounded-[2rem] sm:rounded-[2.2rem] bg-white text-gray-900 shadow-inner flex flex-col justify-between p-3 sm:p-4 text-center">
              {/* Screen Top Header */}
              <div>
                <img src="/earist-logo.png" alt="" className="h-7 w-7 sm:h-8 sm:w-8 object-contain mx-auto" />
                <p className="text-xs sm:text-sm font-black text-gray-900 leading-none mt-1">
                  E-GatePass
                </p>
                <p className="text-[9px] sm:text-[10px] font-bold text-[#b91c1c] uppercase tracking-wider mt-0.5">
                  VISITOR PASS
                </p>
              </div>

              {/* Screen QR */}
              <div className="my-2 sm:my-2.5 flex justify-center">
                <div className="p-1 rounded-lg bg-white border border-gray-100 shadow-xs">
                  <VectorQrCode className="h-24 w-24 sm:h-28 sm:w-28" />
                </div>
              </div>

              {/* Visitor details on screen */}
              <div>
                <p className="text-xs sm:text-sm font-black text-gray-900">
                  Sample Visitor
                </p>
                <p className="text-[10px] sm:text-[11px] font-medium text-gray-500 mt-0.5">
                  Oct 22, 2026
                </p>
                <p className="text-[10px] sm:text-[11px] text-gray-500">
                  Main Campus Gate
                </p>

                {/* QR Ready Green Pill Badge */}
                <div className="mt-2 inline-flex items-center gap-1 px-3 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-extrabold tracking-wide uppercase border border-emerald-200 shadow-xs">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  QR Ready
                </div>
              </div>

              {/* EARIST Classical Building Facade Illustration */}
              <div className="mt-2.5 overflow-hidden rounded-lg border border-gray-100 bg-gray-50">
                <BuildingFacadeGraphic />
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

{/* Vector QR Code SVG component for crisp resolution */}
function VectorQrCode({ className = 'h-32 w-32' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 29 29"
      className={className}
      shapeRendering="crispEdges"
      aria-label="Sample Visitor Access QR Code"
    >
      <rect width="29" height="29" fill="#ffffff" />
      {/* Corner Outer Squares */}
      <rect x="0" y="0" width="7" height="7" fill="#000000" />
      <rect x="1" y="1" width="5" height="5" fill="#ffffff" />
      <rect x="2" y="2" width="3" height="3" fill="#000000" />

      <rect x="22" y="0" width="7" height="7" fill="#000000" />
      <rect x="23" y="1" width="5" height="5" fill="#ffffff" />
      <rect x="24" y="2" width="3" height="3" fill="#000000" />

      <rect x="0" y="22" width="7" height="7" fill="#000000" />
      <rect x="1" y="23" width="5" height="5" fill="#ffffff" />
      <rect x="2" y="24" width="3" height="3" fill="#000000" />

      {/* Alignment and Timing pattern dots */}
      <rect x="8" y="2" width="1" height="1" fill="#000000" />
      <rect x="10" y="2" width="2" height="1" fill="#000000" />
      <rect x="14" y="2" width="1" height="1" fill="#000000" />
      <rect x="16" y="2" width="2" height="1" fill="#000000" />
      <rect x="20" y="2" width="1" height="1" fill="#000000" />

      <rect x="8" y="4" width="2" height="1" fill="#000000" />
      <rect x="12" y="4" width="1" height="1" fill="#000000" />
      <rect x="15" y="4" width="3" height="1" fill="#000000" />
      <rect x="19" y="4" width="2" height="1" fill="#000000" />

      <rect x="6" y="8" width="17" height="1" fill="#000000" />
      <rect x="8" y="6" width="1" height="17" fill="#000000" />

      {/* Inner QR Matrix data modules */}
      <rect x="10" y="9" width="3" height="2" fill="#000000" />
      <rect x="14" y="9" width="1" height="3" fill="#000000" />
      <rect x="17" y="10" width="2" height="1" fill="#000000" />
      <rect x="20" y="9" width="3" height="2" fill="#000000" />

      <rect x="10" y="13" width="2" height="2" fill="#000000" />
      <rect x="13" y="14" width="3" height="1" fill="#000000" />
      <rect x="18" y="13" width="2" height="2" fill="#000000" />
      <rect x="22" y="13" width="1" height="3" fill="#000000" />

      <rect x="11" y="17" width="2" height="3" fill="#000000" />
      <rect x="15" y="16" width="3" height="2" fill="#000000" />
      <rect x="19" y="17" width="2" height="1" fill="#000000" />
      <rect x="23" y="18" width="2" height="2" fill="#000000" />

      <rect x="9" y="22" width="3" height="2" fill="#000000" />
      <rect x="13" y="21" width="2" height="3" fill="#000000" />
      <rect x="17" y="22" width="4" height="2" fill="#000000" />
      <rect x="23" y="22" width="2" height="3" fill="#000000" />

      <rect x="10" y="26" width="2" height="1" fill="#000000" />
      <rect x="14" y="25" width="3" height="2" fill="#000000" />
      <rect x="18" y="26" width="3" height="1" fill="#000000" />
      <rect x="22" y="26" width="1" height="2" fill="#000000" />
    </svg>
  );
}

{/* Classical EARIST Neoclassical Campus Facade Graphic */}
function BuildingFacadeGraphic() {
  return (
    <svg viewBox="0 0 200 65" className="w-full h-12 object-cover text-gray-400 opacity-80" fill="currentColor">
      {/* Sky / Base Horizon */}
      <rect x="0" y="60" width="200" height="5" fill="#4b5563" />
      <rect x="10" y="58" width="180" height="2" fill="#9ca3af" />

      {/* Triangular Classical Pediment */}
      <polygon points="100,6 45,26 155,26" fill="#6b7280" />
      <polygon points="100,9 50,25 150,25" fill="#e5e7eb" />
      <circle cx="100" cy="18" r="4" fill="#a31d1d" opacity="0.6" />

      {/* Entablature Header */}
      <rect x="42" y="26" width="116" height="4" fill="#4b5563" />

      {/* Classical Columns */}
      <rect x="48" y="30" width="6" height="28" fill="#9ca3af" />
      <rect x="62" y="30" width="6" height="28" fill="#9ca3af" />
      <rect x="76" y="30" width="6" height="28" fill="#9ca3af" />
      <rect x="90" y="30" width="6" height="28" fill="#9ca3af" />
      <rect x="104" y="30" width="6" height="28" fill="#9ca3af" />
      <rect x="118" y="30" width="6" height="28" fill="#9ca3af" />
      <rect x="132" y="30" width="6" height="28" fill="#9ca3af" />
      <rect x="146" y="30" width="6" height="28" fill="#9ca3af" />

      {/* Entrance Arches between central columns */}
      <path d="M 86 58 L 86 42 A 8 8 0 0 1 102 42 L 102 58 Z" fill="#374151" />
      <path d="M 104 58 L 104 42 A 8 8 0 0 1 120 42 L 120 58 Z" fill="#374151" />

      {/* Side wings */}
      <rect x="15" y="32" width="27" height="26" fill="#d1d5db" />
      <rect x="158" y="32" width="27" height="26" fill="#d1d5db" />
      {/* Windows on side wings */}
      <rect x="20" y="36" width="6" height="9" fill="#4b5563" />
      <rect x="30" y="36" width="6" height="9" fill="#4b5563" />
      <rect x="163" y="36" width="6" height="9" fill="#4b5563" />
      <rect x="173" y="36" width="6" height="9" fill="#4b5563" />
    </svg>
  );
}

{/* Faint Campus Tower / Architecture Watermark behind left text */}
function CampusWatermark() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute left-[22%] sm:left-[28%] top-6 sm:top-10 w-[240px] sm:w-[320px] h-[360px] opacity-[0.045] select-none text-gray-700 hidden sm:block"
    >
      <svg viewBox="0 0 120 180" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="1.2">
        {/* Tower roof and spire */}
        <line x1="60" y1="5" x2="60" y2="25" />
        <polygon points="60,25 45,45 75,45" />
        {/* Tower clock level */}
        <rect x="42" y="45" width="36" height="30" />
        <circle cx="60" cy="60" r="7" />
        {/* Tower main shaft */}
        <rect x="38" y="75" width="44" height="60" />
        <line x1="48" y1="85" x2="48" y2="120" />
        <line x1="60" y1="85" x2="60" y2="120" />
        <line x1="72" y1="85" x2="72" y2="120" />
        {/* Base / Main Building Roof */}
        <polygon points="60,135 10,150 110,150" />
        <rect x="15" y="150" width="90" height="30" />
        <rect x="30" y="158" width="10" height="18" />
        <rect x="55" y="158" width="10" height="18" />
        <rect x="80" y="158" width="10" height="18" />
      </svg>
    </div>
  );
}

function SectionHeading({
  id,
  eyebrow,
  title,
  description,
  centered = false,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description?: string;
  centered?: boolean;
}) {
  return (
    <div className={`${centered ? 'mx-auto text-center' : ''} max-w-2xl`}>
      <p className="text-xs font-bold uppercase tracking-widest text-[var(--color-institutional)]">
        {eyebrow}
      </p>
      <h2 id={id} className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl text-[var(--color-text-primary)]">
        {title}
      </h2>
      {description && (
        <p className="mt-3 text-base leading-relaxed text-[var(--color-text-secondary)]">
          {description}
        </p>
      )}
    </div>
  );
}

function InstitutionalFooter() {
  const footer = LANDING_CONTENT.footer;
  return (
    <footer className="border-t border-[var(--color-border)] bg-white px-4 py-12 sm:px-6 lg:px-8 xl:px-12 2xl:px-16">
      <div className="mx-auto grid max-w-7xl 2xl:max-w-[1600px] gap-8 md:grid-cols-[1.25fr_0.75fr]">
        <div className="flex items-start gap-4">
          <img src="/earist-logo.png" alt="EARIST seal" className="h-12 w-12 shrink-0 object-contain" />
          <div>
            <h2 className="max-w-xl text-sm font-extrabold uppercase tracking-wide text-[var(--color-text-primary)]">
              {footer.officialName}
            </h2>
            <p className="mt-1.5 text-sm font-semibold text-[var(--color-institutional)]">
              {footer.systemName}
            </p>
            <p className="mt-2.5 flex items-start gap-2 text-sm text-[var(--color-text-secondary)]">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />
              <span>{footer.location}</span>
            </p>
          </div>
        </div>

        <div className="text-sm text-[var(--color-text-secondary)] md:text-right">
          <a
            href={footer.website.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-bold text-[var(--color-institutional)] underline decoration-[var(--color-accent)] decoration-2 underline-offset-4 hover:text-[var(--color-action)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
          >
            {footer.website.text}
          </a>
          <p className="mt-3 leading-relaxed">{footer.privacy}</p>
        </div>
      </div>

      <div className="mx-auto mt-8 max-w-7xl 2xl:max-w-[1600px] border-t border-[var(--color-border)] pt-6 text-xs leading-relaxed text-[var(--color-text-muted)]">
        <p>{footer.project}</p>
        <p className="mt-1">{footer.adviser}</p>
        <p className="mt-3 font-semibold text-[var(--color-text-primary)]">© 2026 EARIST E-GatePass. All rights reserved.</p>
      </div>
    </footer>
  );
}
