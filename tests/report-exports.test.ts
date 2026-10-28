// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportReportToCsv, exportReportToExcel, exportReportToPdf, type ReportExportOptions } from '@/lib/reportExport';

describe('Group H: Unified Report Exports Contract (CSV, XLSX, PDF)', () => {
  let createdBlobs: { blob: Blob; filename: string }[] = [];

  beforeEach(() => {
    createdBlobs = [];
    vi.restoreAllMocks();

    // Mock URL.createObjectURL and URL.revokeObjectURL
    globalThis.URL.createObjectURL = vi.fn().mockImplementation((blob: Blob) => {
      return 'blob:mock-url';
    });
    globalThis.URL.revokeObjectURL = vi.fn();

    // Mock document.createElement('a')
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const el = originalCreateElement(tagName);
      if (tagName === 'a') {
        const originalClick = el.click.bind(el);
        el.click = vi.fn().mockImplementation(() => {
          // record download attempt
        });
      }
      return el;
    });
  });

  interface SampleRecord {
    reference: string;
    visitorName: string;
    visitDate: string;
    purpose: string;
    status: string;
    qrToken?: string;
    tokenDigest?: string;
    photoPublicId?: string;
    signedUrl?: string;
  }

  const sampleRows: SampleRecord[] = [
    {
      reference: 'EG-12345678',
      visitorName: 'Juan Dela Cruz',
      visitDate: '2026-10-28',
      purpose: 'Meeting with Registrar',
      status: 'approved',
      qrToken: 'SECRET_TOKEN_DO_NOT_LEAK',
      tokenDigest: 'SECRET_DIGEST',
      photoPublicId: 'private_bucket/photos/123.jpg',
      signedUrl: 'https://storage.supabase.co/signed?token=xyz',
    },
    {
      reference: 'EG-87654321',
      visitorName: 'Maria Santos',
      visitDate: '2026-10-28',
      purpose: 'Library Research',
      status: 'pending',
    },
  ];

  const safeColumns = [
    { header: 'Pass Ref', key: 'reference' },
    { header: 'Visitor Name', key: 'visitorName' },
    { header: 'Visit Date', key: 'visitDate' },
    { header: 'Purpose', key: 'purpose' },
    { header: 'Status', key: 'status' },
  ];

  const exportOptions: ReportExportOptions<SampleRecord> = {
    title: 'Visitor Records',
    filename: 'visitor-records-2026-10-28',
    columns: safeColumns,
    rows: sampleRows,
    filterMetadata: {
      'Date Range': '2026-10-01 to 2026-10-28',
      Status: 'All',
    },
    generatedBy: 'Admin Test',
  };

  it('exportReportToCsv produces machine-readable CSV starting with header row (no decorative rows)', async () => {
    let capturedBlob: Blob | null = null;
    let capturedFilename = '';

    globalThis.URL.createObjectURL = vi.fn().mockImplementation((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:csv-url';
    });

    await exportReportToCsv(exportOptions);

    expect(capturedBlob).not.toBeNull();
    // Verify content
    const text = await (capturedBlob as unknown as Blob).text();
    const lines = text.split('\r\n');

    // First row MUST be column headers (RFC 4180 requirement)
    expect(lines[0]).toBe('Pass Ref,Visitor Name,Visit Date,Purpose,Status');
    expect(lines[1]).toContain('EG-12345678,Juan Dela Cruz,2026-10-28,Meeting with Registrar,approved');
    expect(lines[2]).toContain('EG-87654321,Maria Santos,2026-10-28,Library Research,pending');

    // Security check: sensitive internal fields must NEVER appear in export output
    expect(text).not.toContain('SECRET_TOKEN_DO_NOT_LEAK');
    expect(text).not.toContain('SECRET_DIGEST');
    expect(text).not.toContain('private_bucket/photos');
    expect(text).not.toContain('signedUrl');
  });

  it('exportReportToExcel dynamically imports exceljs and creates valid XLSX workbook', async () => {
    let capturedBlob: Blob | null = null;
    globalThis.URL.createObjectURL = vi.fn().mockImplementation((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:xlsx-url';
    });

    await exportReportToExcel(exportOptions);

    expect(capturedBlob).not.toBeNull();
    expect((capturedBlob as unknown as Blob).type).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  });

  it('exportReportToPdf dynamically imports jsPDF and generates document with metadata and tables', async () => {
    let capturedBlob: Blob | null = null;
    globalThis.URL.createObjectURL = vi.fn().mockImplementation((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:pdf-url';
    });

    await exportReportToPdf(exportOptions);

    expect(capturedBlob).not.toBeNull();
    expect((capturedBlob as unknown as Blob).type).toBe('application/pdf');
  });
});
