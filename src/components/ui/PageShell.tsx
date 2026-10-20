import { ReactNode } from 'react';
import { BrandMark } from '../BrandMark';

interface PageShellProps {
  children: ReactNode;
  headerContent?: ReactNode;
  sidebarContent?: ReactNode;
  className?: string;
}

export function PageShell({ children, headerContent, sidebarContent, className = '' }: PageShellProps) {
  return (
    <div className={`flex min-h-dvh flex-col bg-[var(--color-canvas)] font-sans md:flex-row ${className}`.trim()}>
      {/* Sidebar for desktop, if provided */}
      {sidebarContent && (
        <aside className="fixed z-40 hidden h-full w-64 flex-col overflow-y-auto bg-[var(--color-brand-dark)] text-white shadow-md md:flex">
          <div className="p-6 flex items-center gap-3">
            <BrandMark size="sm" className="bg-white border-2 border-white/20" />
            <h1 className="font-bold tracking-tight text-white/90">EARIST E-GatePass</h1>
          </div>
          <div className="px-4 flex-1">
            {sidebarContent}
          </div>
        </aside>
      )}

      {/* Main Content Area */}
      <div className={`flex-1 flex flex-col min-w-0 ${sidebarContent ? 'md:ml-64' : ''}`}>
        {/* Header */}
        {(headerContent || sidebarContent) && (
          <header className={`sticky top-0 z-30 flex h-16 items-center justify-between border-b border-[var(--color-border)] bg-white/95 px-4 shadow-sm backdrop-blur-sm sm:px-6 ${sidebarContent ? 'md:hidden' : ''}`}>
            {!sidebarContent && (
              <div className="flex items-center gap-2">
                <BrandMark size="sm" />
                <span className="font-bold text-[var(--color-text-primary)]">EARIST</span>
              </div>
            )}
            
            {sidebarContent && (
              <div className="flex items-center gap-2 md:hidden text-[var(--color-earist-maroon)]">
                <BrandMark size="sm" />
                <span className="font-bold text-[var(--color-text-primary)]">Admin</span>
              </div>
            )}
            
            <div className="flex-1 flex justify-end items-center">
              {headerContent}
            </div>
          </header>
        )}
        
        {/* Page Body */}
        <main id="main-content" className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
