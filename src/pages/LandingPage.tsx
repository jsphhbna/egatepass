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
  UserRound,
} from 'lucide-react';
import { LANDING_CONTENT } from '@/content/landing';

const processIcons = [FileText, Camera, QrCode, ShieldCheck, DoorOpen];
const needIcons = [UserRound, Camera, IdCard, CalendarDays];
const verificationIcons = [ShieldCheck, UserRound, ScanLine, ClipboardCheck];

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
    <div className="min-h-dvh overflow-x-hidden bg-white text-[var(--color-text-primary)]">
      <header className={`sticky top-0 z-50 border-b border-transparent bg-white/95 backdrop-blur transition-shadow ${isScrolled ? 'border-[var(--color-border)] shadow-sm' : ''}`}>
        <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]">
            <img src="/earist-logo.png" alt="EARIST seal" className="h-10 w-10 shrink-0 object-contain" />
            <span className="min-w-0">
              <span className="block truncate text-base font-bold text-[var(--color-institutional)]">{LANDING_CONTENT.header.title}</span>
              <span className="hidden truncate text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)] sm:block">
                {LANDING_CONTENT.header.subtitle}
              </span>
            </span>
          </Link>

          <div className="flex items-center gap-3 lg:gap-6">
            <nav aria-label="Landing page sections" className="hidden items-center gap-5 lg:flex">
              {LANDING_CONTENT.header.navLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={(event) => scrollToSection(event, link.href)}
                  className="rounded-sm text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-institutional)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
                >
                  {link.label}
                </a>
              ))}
            </nav>
            <Link
              to="/get-pass"
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-[var(--color-action)] px-4 text-sm font-bold text-white hover:bg-[var(--color-action-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action)] focus-visible:ring-offset-2"
            >
              <span className="sm:hidden">Get Pass</span>
              <span className="hidden sm:inline">Get Your Gate Pass</span>
            </Link>
          </div>
        </div>
      </header>

      <main id="main-content">
        <section className="relative overflow-hidden bg-[var(--color-institutional)] px-4 py-14 sm:px-6 sm:py-16 lg:px-8 lg:py-20">
          <div aria-hidden="true" className="landing-hero-glow absolute inset-y-0 right-0 w-2/3 opacity-70" />
          <div className="relative mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
            <div className="max-w-2xl text-white">
              <p className="mb-4 text-sm font-bold uppercase tracking-widest text-[var(--color-accent)]">{LANDING_CONTENT.hero.eyebrow}</p>
              <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">{LANDING_CONTENT.hero.title}</h1>
              <p className="mt-5 max-w-xl text-xl font-semibold leading-relaxed text-white">{LANDING_CONTENT.hero.subtitle}</p>
              <p className="mt-3 max-w-xl text-base leading-relaxed text-white/75">{LANDING_CONTENT.hero.supportingText}</p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link
                  to="/get-pass"
                  className="inline-flex min-h-12 items-center justify-center rounded-md bg-[var(--color-action)] px-6 text-base font-bold text-white shadow-md hover:bg-[var(--color-action-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-institutional)]"
                >
                  Get Your Gate Pass
                  <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
                </Link>
                <a
                  href="#how-it-works"
                  onClick={(event) => scrollToSection(event, '#how-it-works')}
                  className="inline-flex min-h-12 items-center justify-center rounded-md border border-white/40 px-6 text-base font-bold text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  How It Works
                </a>
              </div>

              <div className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium text-white/75">
                <span className="inline-flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />No visitor account needed</span>
                <span className="inline-flex items-center gap-2"><Smartphone className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />Works on phone or kiosk</span>
              </div>
            </div>

            <SampleGatePass />
          </div>
        </section>

        <section id="how-it-works" aria-labelledby="process-heading" className="scroll-mt-20 bg-white px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <SectionHeading id="process-heading" eyebrow="Visitor process" title={LANDING_CONTENT.process.heading} description={LANDING_CONTENT.process.intro} centered />
          <ol className="relative mx-auto mt-12 grid max-w-6xl gap-8 md:grid-cols-5 md:gap-4">
            <div aria-hidden="true" className="absolute bottom-10 left-5 top-10 w-px bg-[var(--color-accent)] md:bottom-auto md:left-[10%] md:right-[10%] md:top-6 md:h-px md:w-auto" />
            {LANDING_CONTENT.process.steps.map((step, index) => {
              const Icon = processIcons[index] ?? FileText;
              return (
                <li key={step.title} className="relative flex gap-5 md:flex-col md:items-center md:text-center">
                  <div className="relative z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--color-institutional)] text-sm font-bold text-white ring-4 ring-white">
                    {index + 1}
                  </div>
                  <div className="pt-1 md:pt-0">
                    <Icon className="mb-3 hidden h-5 w-5 text-[var(--color-institutional)] md:mx-auto md:block" aria-hidden="true" />
                    <h3 className="text-base font-bold">{step.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">{step.text}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <section id="what-you-need" aria-labelledby="needs-heading" className="scroll-mt-20 bg-[var(--color-canvas)] px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div className="mx-auto max-w-7xl">
            <SectionHeading id="needs-heading" eyebrow="Before you begin" title={LANDING_CONTENT.needs.heading} description={LANDING_CONTENT.needs.intro} />
            <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {LANDING_CONTENT.needs.items.map((item, index) => {
                const Icon = needIcons[index] ?? FileText;
                return (
                  <article key={item.title} className="rounded-xl border border-[var(--color-border)] bg-white p-6 shadow-sm">
                    <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--color-brand-light)] text-[var(--color-institutional)]">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <h3 className="text-lg font-bold">{item.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">{item.text}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section aria-labelledby="verification-heading" className="bg-white px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
            <div className="rounded-2xl bg-[var(--color-institutional)] p-7 text-white sm:p-9">
              <ShieldCheck className="h-10 w-10 text-[var(--color-accent)]" aria-hidden="true" />
              <h2 id="verification-heading" className="mt-6 text-3xl font-bold tracking-tight">{LANDING_CONTENT.verification.heading}</h2>
              <p className="mt-4 max-w-xl text-base leading-relaxed text-white/75">{LANDING_CONTENT.verification.intro}</p>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              {LANDING_CONTENT.verification.points.map((point, index) => {
                const Icon = verificationIcons[index] ?? ShieldCheck;
                return (
                  <article key={point.title} className="flex gap-4 rounded-xl border border-[var(--color-border)] p-5">
                    <Icon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-institutional)]" aria-hidden="true" />
                    <div>
                      <h3 className="font-bold">{point.title}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-[var(--color-text-secondary)]">{point.text}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section id="privacy" aria-labelledby="privacy-heading" className="scroll-mt-20 bg-[var(--color-canvas)] px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div className="mx-auto max-w-5xl rounded-2xl border border-[var(--color-border)] bg-white p-7 shadow-sm sm:p-10">
            <div className="grid gap-8 md:grid-cols-[0.75fr_1.25fr]">
              <div>
                <p className="text-sm font-bold uppercase tracking-widest text-[var(--color-institutional)]">Responsible data use</p>
                <h2 id="privacy-heading" className="mt-3 text-3xl font-bold tracking-tight">{LANDING_CONTENT.privacy.heading}</h2>
                <p className="mt-4 text-base leading-relaxed text-[var(--color-text-secondary)]">{LANDING_CONTENT.privacy.intro}</p>
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
                <p className="mt-6 border-t border-[var(--color-border)] pt-5 text-sm font-semibold text-[var(--color-text-primary)]">{LANDING_CONTENT.privacy.law}</p>
              </div>
            </div>
          </div>
        </section>

        <section id="faq" aria-labelledby="faq-heading" className="scroll-mt-20 bg-white px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div className="mx-auto max-w-3xl">
            <SectionHeading id="faq-heading" eyebrow="Visitor help" title={LANDING_CONTENT.faq.heading} centered />
            <div className="mt-10 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
              {LANDING_CONTENT.faq.items.map((item) => (
                <details key={item.q} className="group">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-4 font-bold text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] [&::-webkit-details-marker]:hidden">
                    <span>{item.q}</span>
                    <ChevronDown className="h-5 w-5 shrink-0 text-[var(--color-text-secondary)] transition-transform group-open:rotate-180" aria-hidden="true" />
                  </summary>
                  <p className="max-w-2xl pb-5 pr-8 text-sm leading-relaxed text-[var(--color-text-secondary)]">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-[var(--color-institutional)] px-4 py-14 text-center text-white sm:px-6 lg:px-8">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-3xl font-bold tracking-tight">{LANDING_CONTENT.finalCta.heading}</h2>
            <p className="mx-auto mt-3 max-w-xl text-base leading-relaxed text-white/75">{LANDING_CONTENT.finalCta.text}</p>
            <Link
              to="/get-pass"
              className="mt-7 inline-flex min-h-12 items-center justify-center rounded-md bg-white px-7 text-base font-bold text-[var(--color-institutional)] shadow-sm hover:bg-[var(--color-canvas)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-institutional)]"
            >
              Get Your Gate Pass
              <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
            </Link>
          </div>
        </section>
      </main>

      <InstitutionalFooter />
    </div>
  );
}

function SampleGatePass() {
  return (
    <aside aria-label="Example digital gate pass" className="mx-auto w-full max-w-md lg:mx-0 lg:justify-self-end">
      <div className="rounded-2xl border border-white/15 bg-white p-5 shadow-lg sm:p-6">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-4">
          <div className="flex items-center gap-3">
            <img src="/earist-logo.png" alt="" className="h-10 w-10 object-contain" />
            <div>
              <p className="text-sm font-extrabold text-[var(--color-institutional)]">E-GatePass</p>
              <p className="text-xs text-[var(--color-text-secondary)]">Sample visitor pass</p>
            </div>
          </div>
          <span className="rounded-full bg-[var(--color-success-light)] px-3 py-1 text-xs font-bold text-[var(--color-success)]">QR ready</span>
        </div>

        <div className="grid gap-5 py-6 sm:grid-cols-[9rem_1fr] sm:items-center">
          <div className="mx-auto flex aspect-square w-36 items-center justify-center rounded-xl border border-[var(--color-border)] bg-white shadow-sm">
            <QrCode className="h-28 w-28 text-[var(--color-text-primary)]" strokeWidth={1.4} aria-hidden="true" />
          </div>
          <dl className="grid gap-4 text-sm">
            <PassDetail term="Visitor" description="Sample Visitor" />
            <PassDetail term="Visit date" description="Selected visit date" />
            <PassDetail term="Entry point" description="Assigned campus gate" />
          </dl>
        </div>

        <div className="flex items-start gap-3 rounded-lg bg-[var(--color-brand-light)] p-4 text-sm">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-institutional)]" aria-hidden="true" />
          <div>
            <p className="font-bold text-[var(--color-text-primary)]">Verification at the gate</p>
            <p className="mt-1 leading-relaxed text-[var(--color-text-secondary)]">A QR code is not automatic entry approval. Campus security verifies each visitor after scanning.</p>
          </div>
        </div>
      </div>
      <p className="mt-3 text-center text-xs font-medium text-white/60">Illustration only — your pass is created after registration.</p>
    </aside>
  );
}

function PassDetail({ term, description }: { term: string; description: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">{term}</dt>
      <dd className="mt-1 font-bold text-[var(--color-text-primary)]">{description}</dd>
    </div>
  );
}

function SectionHeading({ id, eyebrow, title, description, centered = false }: { id: string; eyebrow: string; title: string; description?: string; centered?: boolean }) {
  return (
    <div className={`${centered ? 'mx-auto text-center' : ''} max-w-2xl`}>
      <p className="text-sm font-bold uppercase tracking-widest text-[var(--color-institutional)]">{eyebrow}</p>
      <h2 id={id} className="mt-3 text-3xl font-bold tracking-tight">{title}</h2>
      {description && <p className="mt-3 text-base leading-relaxed text-[var(--color-text-secondary)]">{description}</p>}
    </div>
  );
}

function InstitutionalFooter() {
  const footer = LANDING_CONTENT.footer;
  return (
    <footer className="border-t border-[var(--color-border)] bg-white px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-8 md:grid-cols-[1.25fr_0.75fr]">
        <div className="flex items-start gap-4">
          <img src="/earist-logo.png" alt="EARIST seal" className="h-12 w-12 shrink-0 object-contain" />
          <div>
            <h2 className="max-w-xl text-sm font-extrabold uppercase tracking-wide text-[var(--color-text-primary)]">{footer.officialName}</h2>
            <p className="mt-2 text-sm font-semibold text-[var(--color-institutional)]">{footer.systemName}</p>
            <p className="mt-3 flex items-start gap-2 text-sm text-[var(--color-text-secondary)]">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{footer.location}</span>
            </p>
          </div>
        </div>

        <div className="text-sm text-[var(--color-text-secondary)] md:text-right">
          <a href={footer.website.href} target="_blank" rel="noopener noreferrer" className="font-bold text-[var(--color-institutional)] underline decoration-[var(--color-accent)] decoration-2 underline-offset-4 hover:text-[var(--color-action)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]">
            {footer.website.text}
          </a>
          <p className="mt-4 leading-relaxed">{footer.privacy}</p>
        </div>
      </div>
      <div className="mx-auto mt-8 max-w-7xl border-t border-[var(--color-border)] pt-6 text-xs leading-relaxed text-[var(--color-text-muted)]">
        <p>{footer.project}</p>
        <p className="mt-1">{footer.adviser}</p>
        <p className="mt-3">© 2026 EARIST E-GatePass</p>
      </div>
    </footer>
  );
}
