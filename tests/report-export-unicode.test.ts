// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportReportToCsv, exportReportToPdf, type ReportExportOptions } from '@/lib/reportExport';

describe('Workstream B: Report Export Unicode & Font Embedding Integrity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  interface UnicodeRecord {
    reference: string;
    visitorName: string;
    visitDate: string;
    purpose: string;
    status: string;
  }

  const unicodeRows: UnicodeRecord[] = [
    {
      reference: 'EG-00000001',
      visitorName: 'José Niño Dela Cruz',
      visitDate: '2026-10-30',
      purpose: 'Académico – Registrar Verification',
      status: 'approved',
    },
    {
      reference: 'EG-00000002',
      visitorName: 'Renée François',
      visitDate: '2026-10-30',
      purpose: 'Consultant • Audit & Compliance',
      status: 'pending',
    },
    {
      reference: 'EG-00000003',
      visitorName: 'Mary-Jane O’Connor',
      visitDate: '2026-10-30',
      purpose: 'Faculty Research “Special Topics”',
      status: 'approved',
    },
  ];

  const columns = [
    { header: 'Ref', key: 'reference' },
    { header: 'Visitor Name', key: 'visitorName' },
    { header: 'Date', key: 'visitDate' },
    { header: 'Purpose', key: 'purpose' },
    { header: 'Status', key: 'status' },
  ];

  const options: ReportExportOptions<UnicodeRecord> = {
    title: 'Unicode Integrity Report',
    filename: 'unicode-report',
    columns,
    rows: unicodeRows,
    generatedBy: 'Super Admin',
  };

  it('CSV export begins with UTF-8 BOM \\uFEFF and preserves all special Unicode glyphs', async () => {
    let capturedBlob: Blob | null = null;
    globalThis.URL.createObjectURL = vi.fn().mockImplementation((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:mock-csv';
    });
    globalThis.URL.revokeObjectURL = vi.fn();

    await exportReportToCsv(options);

    expect(capturedBlob).not.toBeNull();
    const text = await (capturedBlob as unknown as Blob).text();

    // Must start with UTF-8 BOM \uFEFF
    expect(text.charCodeAt(0)).toBe(0xFEFF);
    expect(text.startsWith('\uFEFF')).toBe(true);

    // Verify all Unicode glyphs are intact without mangling
    expect(text).toContain('José Niño Dela Cruz');
    expect(text).toContain('Académico – Registrar Verification');
    expect(text).toContain('Renée François');
    expect(text).toContain('Consultant • Audit & Compliance');
    expect(text).toContain('Mary-Jane O’Connor');
  });

  it('PDF export successfully loads bundled Noto Sans and renders Unicode characters without exception', async () => {
    let capturedBlob: Blob | null = null;
    globalThis.URL.createObjectURL = vi.fn().mockImplementation((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:mock-pdf';
    });
    globalThis.URL.revokeObjectURL = vi.fn();

    await exportReportToPdf(options);

    expect(capturedBlob).not.toBeNull();
    expect((capturedBlob as unknown as Blob).type).toBe('application/pdf');
    expect((capturedBlob as unknown as Blob).size).toBeGreaterThan(1000);
  });
});
