import { Link } from 'react-router-dom';
import { BrandMark } from '@/components/BrandMark';
import { Button, Card } from '@/components/ui';

export function NotFoundPage() {
  return (
    <main id="main-content" className="flex min-h-dvh items-center justify-center bg-[var(--color-canvas)] px-4 py-12">
      <Card className="w-full max-w-md text-center p-8 border-t-4 border-t-[var(--color-brand)]">
        <BrandMark size="lg" className="mx-auto mb-4" />
        <p className="text-xs font-bold uppercase tracking-widest text-[var(--color-brand)]">404 Error</p>
        <h1 className="mt-2 text-2xl font-bold text-[var(--color-text-primary)]">Page Not Found</h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-text-secondary)]">
          The requested page could not be found. It may have been moved, renamed, or is temporarily unavailable.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link to="/">
            <Button variant="primary" size="md">
              Return to Home
            </Button>
          </Link>
          <Link to="/login">
            <Button variant="secondary" size="md">
              Sign In
            </Button>
          </Link>
        </div>
      </Card>
    </main>
  );
}
