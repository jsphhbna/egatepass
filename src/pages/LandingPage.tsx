import { useEffect, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CalendarDays,
  Camera,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  DoorOpen,
  FileText,
  IdCard,
  MapPin,
  QrCode,
  ScanLine,
  ShieldCheck,
  Smartphone,
  UserCheck,
  UserRound,
} from 'lucide-react';
import { LANDING_CONTENT } from '@/content/landing';

const processIcons = [FileText, Camera, QrCode, ShieldCheck, DoorOpen];
const needIcons = [UserRound, Camera, IdCard, CalendarDays];
const verificationIcons = [ShieldCheck, UserCheck, ScanLine, ClipboardCheck];

export function LandingPage() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 12);
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
    <div className="min-h-dvh overflow-x-hidden bg-white text-[var(--color-text-primary)] antialiased">
      {/* ============================================================
          FIX GROUP 2: HEADER / NAVIGATION VISUAL REFINEMENT
          ============================================================ */}
      <header
        className={`sticky top-0 z-50 border-b bg-white/95 backdrop-blur transition-shadow ${
          isScrolled ? 'border-[var(--color-border)] shadow-sm' : 'border-transparent'
        }`}
      >
        <div className="mx-auto flex min-h-16 max-w-7xl 2xl:max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8 xl:px-12 2xl:px-16">
          <Link
            to="/"
            className="flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
          >
            <img src="/earist-logo.png" alt="EARIST seal" className="h-10 w-10 shrink-0 object-contain" />
            <span className="min-w-0">
              <span className="block truncate text-base font-extrabold text-[var(--color-institutional)]">
                {LANDING_CONTENT.header.title}
              </span>
              <span className="hidden truncate text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] sm:block">
                {LANDING_CONTENT.header.subtitle}
              </span>
            </span>
          </Link>

          <div className="flex items-center gap-4 lg:gap-8">
            <nav aria-label="Landing page sections" className="hidden items-center gap-6 lg:flex">
              {LANDING_CONTENT.header.navLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={(event) => scrollToSection(event, link.href)}
                  className="rounded-sm text-sm font-semibold text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-institutional)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
                >
                  {link.label}
                </a>
              ))}
            </nav>
            <Link
              to="/get-pass"
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-[var(--color-action)] px-5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[var(--color-action-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action)] focus-visible:ring-offset-2"
            >
              <span className="sm:hidden">Get Pass</span>
              <span className="hidden sm:inline">Get Your Gate Pass</span>
            </Link>
          </div>
        </div>
      </header>

      <main id="main-content">
        {/* ============================================================
            FIX GROUP 1 & 3: HERO SECTION WITH OFFICIAL EARIST IDENTITY
            ============================================================ */}
        <section className="relative overflow-hidden bg-[var(--color-institutional)] px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24 xl:px-12 2xl:px-16 2xl:py-28">
          {/* Subtle institutional seal watermark */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-20 -top-20 h-[500px] w-[500px] rounded-full opacity-[0.06] lg:h-[700px] lg:w-[700px]"
            style={{
              backgroundImage: 'url(/earist-logo.png)',
              backgroundSize: 'contain',
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'center',
            }}
          />

          <div className="relative mx-auto grid max-w-7xl 2xl:max-w-[1600px] items-center gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16 2xl:gap-20">
            {/* Left Column: Official Institutional Copy */}
            <div className="max-w-2xl text-white">
              <div className="inline-flex items-center gap-2 rounded-full border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 px-3.5 py-1 text-xs font-bold uppercase tracking-widest text-[var(--color-accent)]">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{LANDING_CONTENT.hero.eyebrow}</span>
              </div>

              <h1 className="mt-5 text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl">
                {LANDING_CONTENT.hero.title}
              </h1>
              <p className="mt-4 text-xl font-bold leading-relaxed text-white/95 sm:text-2xl">
                {LANDING_CONTENT.hero.subtitle}
              </p>
              <p className="mt-3 max-w-xl text-base leading-relaxed text-white/80">
                {LANDING_CONTENT.hero.supportingText}
              </p>

              {/* CTAs */}
              <div className="mt-8 flex flex-col gap-3.5 sm:flex-row">
                <Link
                  to="/get-pass"
                  className="inline-flex min-h-12 items-center justify-center rounded-md bg-[var(--color-action)] px-7 text-base font-bold text-white shadow-md transition-colors hover:bg-[var(--color-action-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-institutional)]"
                >
                  Get Your Gate Pass
                  <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
                </Link>
                <a
                  href="#how-it-works"
                  onClick={(event) => scrollToSection(event, '#how-it-works')}
                  className="inline-flex min-h-12 items-center justify-center rounded-md border border-white/40 px-6 text-base font-bold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  How It Works
                </a>
              </div>

              {/* Trust Indicators */}
              <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2.5 text-sm font-medium text-white/80">
                <span className="inline-flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
                  No visitor account needed
                </span>
                <span className="inline-flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
                  Works on mobile or kiosk
                </span>
                <span className="inline-flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
                  Secure and privacy-focused
                </span>
              </div>
            </div>

            {/* Right Column: Hero Artwork (Phone Mockup + Physical Pass Mockup) */}
            <HeroArtwork />
          </div>
        </section>

        {/* ============================================================
            FIX GROUP 4: "HOW E-GATEPASS WORKS" PROCESS TIMELINE
            ============================================================ */}
        <section
          id="how-it-works"
          aria-labelledby="process-heading"
          className="scroll-mt-20 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24 xl:px-12 2xl:px-16"
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
                    className="flex flex-col justify-start rounded-xl border border-[var(--color-border)] bg-white p-6 shadow-xs transition-shadow hover:shadow-sm"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-brand-light)] text-[var(--color-institutional)]">
                        <Icon className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <h3 className="font-bold text-[var(--color-text-primary)]">{point.title}</h3>
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-[var(--color-text-secondary)]">{point.text}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* ============================================================
            FIX GROUP 7: PRIVACY AND SAFETY POLICY SECTION
            ============================================================ */}
        <section
          id="privacy"
          aria-labelledby="privacy-heading"
          className="scroll-mt-20 bg-[var(--color-canvas)] px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24 xl:px-12 2xl:px-16"
        >
          <div className="mx-auto max-w-5xl 2xl:max-w-6xl rounded-2xl border border-[var(--color-border)] bg-white p-8 shadow-sm sm:p-12">
            <div className="grid gap-8 md:grid-cols-[0.8fr_1.2fr]">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-[var(--color-institutional)]">
                  Responsible Data Use
                </p>
                <h2 id="privacy-heading" className="mt-3 text-3xl font-bold tracking-tight text-[var(--color-text-primary)]">
                  {LANDING_CONTENT.privacy.heading}
                </h2>
                <p className="mt-4 text-base leading-relaxed text-[var(--color-text-secondary)]">
                  {LANDING_CONTENT.privacy.intro}
                </p>
              </div>

              <div>
                <ul className="space-y-4">
                  {LANDING_CONTENT.privacy.points.map((point) => (
                    <li key={point} className="flex gap-3 text-sm leading-relaxed text-[var(--color-text-secondary)]">
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-success)]" aria-hidden="true" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6 border-t border-[var(--color-border)] pt-5">
                  <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Legal Compliance
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[var(--color-text-primary)]">
                    {LANDING_CONTENT.privacy.law}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============================================================
            FIX GROUP 8: RESTYLED ACCESSIBLE FAQ
            ============================================================ */}
        <section
          id="faq"
          aria-labelledby="faq-heading"
          className="scroll-mt-20 bg-white px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24 xl:px-12 2xl:px-16"
        >
          <div className="mx-auto max-w-3xl 2xl:max-w-4xl">
            <SectionHeading id="faq-heading" eyebrow="Visitor assistance" title={LANDING_CONTENT.faq.heading} centered />

            <div className="mt-10 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
              {LANDING_CONTENT.faq.items.map((item) => (
                <details key={item.q} className="group">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-4 text-base font-bold text-[var(--color-text-primary)] transition-colors hover:text-[var(--color-institutional)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] [&::-webkit-details-marker]:hidden">
                    <span>{item.q}</span>
                    <ChevronDown className="h-5 w-5 shrink-0 text-[var(--color-text-secondary)] transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
                  </summary>
                  <p className="max-w-2xl pb-5 pr-8 text-sm leading-relaxed text-[var(--color-text-secondary)]">
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
        <section className="bg-[var(--color-institutional)] px-4 py-16 text-center text-white sm:px-6 sm:py-20 lg:px-8 xl:px-12 2xl:px-16">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
              {LANDING_CONTENT.finalCta.heading}
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-white/80">
              {LANDING_CONTENT.finalCta.text}
            </p>
            <Link
              to="/get-pass"
              className="mt-8 inline-flex min-h-12 items-center justify-center rounded-md bg-white px-8 text-base font-bold text-[var(--color-institutional)] shadow-md transition-colors hover:bg-[var(--color-canvas)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-institutional)]"
            >
              Get Your Gate Pass
              <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
            </Link>
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

/**
 * HeroArtwork Component:
 * Pure CSS/UI visual composition featuring a smartphone mockup displaying
 * the digital QR gate pass alongside an institutional visitor card badge.
 */
function HeroArtwork() {
  return (
    <aside aria-label="Digital and physical gate pass preview" className="mx-auto w-full max-w-lg lg:mx-0 lg:justify-self-end">
      <div className="relative mx-auto flex items-center justify-center py-4">
        {/* Physical Pass Card (Offset in background) */}
        <div
          aria-hidden="true"
          className="absolute -right-2 top-2 hidden w-72 rounded-2xl border border-white/20 bg-white p-5 text-[var(--color-text-primary)] shadow-2xl sm:block lg:-right-4"
        >
          <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] pb-3">
            <img src="/earist-logo.png" alt="" className="h-7 w-7 object-contain" />
            <div>
              <p className="text-xs font-extrabold uppercase tracking-wide text-[var(--color-institutional)]">
                EARIST Security
              </p>
              <p className="text-[10px] text-[var(--color-text-secondary)]">Official Visitor Pass</p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs font-semibold">
            <span className="text-[var(--color-text-secondary)]">Gate 1 • Nagtahan</span>
            <span className="rounded bg-[var(--color-success-light)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-success)]">
              Verified
            </span>
          </div>
        </div>

        {/* Smartphone Mockup with Digital Gate Pass (Main focus) */}
        <div className="relative z-10 w-full max-w-sm rounded-[2.5rem] border-[6px] border-slate-900 bg-slate-900 p-2.5 shadow-2xl ring-1 ring-white/20">
          {/* Phone Screen Canvas */}
          <div className="overflow-hidden rounded-[2rem] bg-white text-[var(--color-text-primary)]">
            {/* Phone Screen Top Header Bar */}
            <div className="bg-[var(--color-institutional)] px-4 py-3 text-white">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <img src="/earist-logo.png" alt="" className="h-6 w-6 object-contain" />
                  <span className="text-xs font-bold tracking-wide">E-GatePass</span>
                </div>
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                  QR Ready
                </span>
              </div>
            </div>

            {/* QR Card Content */}
            <div className="p-5 text-center">
              <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
                Campus Visitor Pass
              </p>
              <p className="mt-1 text-base font-extrabold text-[var(--color-text-primary)]">
                JUAN DELA CRUZ
              </p>
              <p className="text-xs text-[var(--color-text-secondary)]">Purpose: Academic Inquiry</p>

              {/* Scannable QR Container */}
              <div className="mx-auto my-4 flex aspect-square w-40 items-center justify-center rounded-xl border-2 border-dashed border-[var(--color-border)] bg-[var(--color-canvas)] p-2">
                <QrCode className="h-32 w-32 text-[var(--color-institutional)]" strokeWidth={1.5} aria-hidden="true" />
              </div>

              {/* Status and Gate details */}
              <div className="rounded-lg bg-[var(--color-brand-light)] p-3 text-left text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[var(--color-text-secondary)]">Entry Point:</span>
                  <span className="font-bold text-[var(--color-institutional)]">Main Gate</span>
                </div>
                <div className="mt-1 flex items-center justify-between">
                  <span className="font-semibold text-[var(--color-text-secondary)]">Validity:</span>
                  <span className="font-bold text-[var(--color-text-primary)]">Today • Visiting Hours</span>
                </div>
              </div>

              <p className="mt-3 text-[11px] font-medium text-[var(--color-text-secondary)]">
                Present this QR code to security at the gate upon arrival.
              </p>
            </div>
          </div>
        </div>
      </div>
      <p className="mt-2 text-center text-xs font-medium text-white/60">
        Sample preview — your unique pass is generated upon submission.
      </p>
    </aside>
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
