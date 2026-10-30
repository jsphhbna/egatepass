// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  exportReportToCsv,
  exportReportToPdf,
  exportReportToExcel,
  __resetCachedPdfFontsForTests,
  type ReportExportOptions,
} from '@/lib/reportExport';

describe('Workstream B: Report Export Unicode & Font Embedding Integrity', () => {
  const regularFontBuffer = fs.readFileSync(path.resolve(process.cwd(), 'public/fonts/NotoSans-Regular.ttf'));
  const boldFontBuffer = fs.readFileSync(path.resolve(process.cwd(), 'public/fonts/NotoSans-Bold.ttf'));

  beforeEach(() => {
    vi.restoreAllMocks();
    __resetCachedPdfFontsForTests();

    // Default fetch mock supplying genuine bundled font buffers
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('NotoSans-Regular.ttf')) {
        return new Response(regularFontBuffer, { status: 200 });
      }
      if (url.includes('NotoSans-Bold.ttf')) {
        return new Response(boldFontBuffer, { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });
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

  it('CSV export begins with UTF-8 BOM EF BB BF and preserves all special Unicode glyphs', async () => {
    let capturedBlob: Blob | null = null;
    globalThis.URL.createObjectURL = vi.fn().mockImplementation((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:mock-csv';
    });
    globalThis.URL.revokeObjectURL = vi.fn();

    await exportReportToCsv(options);

    expect(capturedBlob).not.toBeNull();
    const arrayBuffer = await (capturedBlob as unknown as Blob).arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Verify exact raw BOM bytes: 0xEF, 0xBB, 0xBF
    expect(bytes[0]).toBe(0xEF);
    expect(bytes[1]).toBe(0xBB);
    expect(bytes[2]).toBe(0xBF);

    const text = await (capturedBlob as unknown as Blob).text();
    expect(text.charCodeAt(0)).toBe(0xFEFF);
    expect(text.startsWith('\uFEFF')).toBe(true);

    // Verify all Unicode glyphs are intact without mangling
    expect(text).toContain('José Niño Dela Cruz');
    expect(text).toContain('Académico – Registrar Verification');
    expect(text).toContain('Renée François');
    expect(text).toContain('Consultant • Audit & Compliance');
    expect(text).toContain('Mary-Jane O’Connor');
  });

  it('PDF export proves custom font embedding (EgatepassNoto) in generated binary', async () => {
    let capturedBlob: Blob | null = null;
    globalThis.URL.createObjectURL = vi.fn().mockImplementation((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:mock-pdf';
    });
    globalThis.URL.revokeObjectURL = vi.fn();

    await exportReportToPdf(options);

    expect(capturedBlob).not.toBeNull();
    expect((capturedBlob as unknown as Blob).type).toBe('application/pdf');

    const arrayBuffer = await (capturedBlob as unknown as Blob).arrayBuffer();
    const binary = Buffer.from(arrayBuffer).toString('latin1');

    // Asserts evidence of custom font registration in PDF stream
    expect(binary).toContain('EgatepassNoto');
  });

  it('PDF font-load failure contract: aborts export with error when fonts are unavailable', async () => {
    __resetCachedPdfFontsForTests();

    // Mock fetch failure
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404, statusText: 'Not Found' }));

    let downloadTriggered = false;
    globalThis.URL.createObjectURL = vi.fn().mockImplementation(() => {
      downloadTriggered = true;
      return 'blob:fail-pdf';
    });

    await expect(exportReportToPdf(options)).rejects.toThrow('Failed to load authoritative Noto Sans fonts for PDF export');
    expect(downloadTriggered).toBe(false);
  });

  it('XLSX export successfully round-trips accented Unicode cells through ExcelJS workbook parser', async () => {
    let capturedBlob: Blob | null = null;
    globalThis.URL.createObjectURL = vi.fn().mockImplementation((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:mock-xlsx';
    });
    globalThis.URL.revokeObjectURL = vi.fn();

    await exportReportToExcel(options);

    expect(capturedBlob).not.toBeNull();
    const arrayBuffer = await (capturedBlob as unknown as Blob).arrayBuffer();

    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);

    const sheet = workbook.worksheets[0];
    expect(sheet).toBeDefined();

    // Search for cells matching Unicode values
    const cellValues: string[] = [];
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.value) {
          cellValues.push(String(cell.value));
        }
      });
    });

    expect(cellValues).toContain('José Niño Dela Cruz');
    expect(cellValues).toContain('Académico – Registrar Verification');
    expect(cellValues).toContain('Renée François');
    expect(cellValues).toContain('Consultant • Audit & Compliance');
    expect(cellValues).toContain('Mary-Jane O’Connor');
  }, 30000);
});
