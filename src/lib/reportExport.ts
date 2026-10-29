import { formatManilaDateTime } from './manilaTime';

export interface ReportColumn<T> {
  header: string;
  key: string;
  width?: number;
  format?: (value: any, row: T) => string;
}

export interface ReportExportOptions<T> {
  title?: string;
  reportTitle?: string;
  sheetName?: string;
  orientation?: 'portrait' | 'landscape';
  subtitle?: string;
  filename: string;
  columns: ReportColumn<T>[];
  rows: T[];
  filterMetadata?: Record<string, string | number | null | undefined>;
  generatedAt?: string;
  generatedBy?: string;
}

/**
 * Neutralizes spreadsheet formula injection in CSV text cells.
 * If a text value, after leading whitespace, begins with =, +, -, @, tab, or carriage return,
 * prefix it with a single quote (').
 */
export function sanitizeSpreadsheetText(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  const trimmed = str.replace(/^[ \t\r\n]+/, '');
  if (/^[=+\-@\t\r]/.test(str) || /^[=+\-@\t\r]/.test(trimmed)) {
    return `'${str}`;
  }
  return str;
}

/**
 * Escapes CSV field value conforming to RFC 4180
 */
function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  const sanitized = sanitizeSpreadsheetText(val);
  if (sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n') || sanitized.includes('\r')) {
    return `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

function getCellValue<T>(row: T, col: ReportColumn<T>): string {
  const raw = (row as any)[col.key];
  if (col.format) {
    return col.format(raw, row);
  }
  if (raw === null || raw === undefined) return '';
  return String(raw);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Clean machine-readable CSV export (RFC 4180) with UTF-8 BOM.
 * Does NOT prepend decorative rows. First row is column headers.
 */
export async function exportReportToCsv<T>(options: ReportExportOptions<T>): Promise<void> {
  const headerLine = options.columns.map((c) => escapeCsvCell(c.header)).join(',');
  const rowLines = options.rows.map((row) =>
    options.columns.map((col) => escapeCsvCell(getCellValue(row, col))).join(',')
  );

  const csvContent = [headerLine, ...rowLines].join('\r\n');
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, options.filename.endsWith('.csv') ? options.filename : `${options.filename}.csv`);
}

/**
 * Excel / XLSX export using exceljs
 */
export async function exportReportToExcel<T>(options: ReportExportOptions<T>): Promise<void> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'EARIST E-GatePass';
  workbook.lastModifiedBy = options.generatedBy || 'System';
  workbook.created = new Date();

  const reportTitle = options.reportTitle ?? options.title ?? 'Report';
  const sheetTitle = (options.sheetName ?? reportTitle).slice(0, 31);
  const worksheet = workbook.addWorksheet(sheetTitle);

  // 1. Report Title & Metadata Section
  const titleRow = worksheet.addRow([`EARIST E-GatePass — ${reportTitle}`]);
  titleRow.font = { bold: true, size: 14, color: { argb: '800000' } };

  if (options.subtitle) {
    const subRow = worksheet.addRow([options.subtitle]);
    subRow.font = { italic: true, size: 10, color: { argb: '555555' } };
  }

  const generatedTime = options.generatedAt || formatManilaDateTime(new Date());
  worksheet.addRow([`Generated: ${generatedTime} | By: ${options.generatedBy || 'Authorized Staff'}`]);

  if (options.filterMetadata) {
    const filterStrings = Object.entries(options.filterMetadata)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}: ${v}`);
    if (filterStrings.length > 0) {
      worksheet.addRow([`Filters: ${filterStrings.join(' | ')}`]);
    }
  }

  // Blank row separator before table
  worksheet.addRow([]);

  // 2. Table Headers
  const headerRow = worksheet.addRow(options.columns.map((c) => c.header));
  headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: '800000' }, // EARIST maroon
  };

  // 3. Table Rows
  for (const row of options.rows) {
    const rowValues = options.columns.map((col) => getCellValue(row, col));
    worksheet.addRow(rowValues);
  }

  // 4. Formatting and Column Widths
  worksheet.columns.forEach((column, i) => {
    const colDef = options.columns[i];
    if (colDef?.width) {
      column.width = colDef.width;
    } else {
      column.width = 18;
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  triggerDownload(blob, options.filename.endsWith('.xlsx') ? options.filename : `${options.filename}.xlsx`);
}

let cachedFontRegularBase64: string | null = null;
let cachedFontBoldBase64: string | null = null;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    const b = bytes[i];
    if (b !== undefined) {
      binary += String.fromCharCode(b);
    }
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

/**
 * Loads and embeds authoritative Noto Sans font binaries into jsPDF Virtual File System (VFS).
 * Pure browser fetch: retrieves /fonts/NotoSans-Regular.ttf and /fonts/NotoSans-Bold.ttf.
 * Fails closed: if either font cannot be fetched, aborts and throws an authoritative error.
 * Caches loaded base64 strings so repeated exports do not re-fetch.
 */
export async function loadNotoPdfFonts(doc: any): Promise<void> {
  if (!cachedFontRegularBase64 || !cachedFontBoldBase64) {
    try {
      const [resReg, resBold] = await Promise.all([
        fetch('/fonts/NotoSans-Regular.ttf'),
        fetch('/fonts/NotoSans-Bold.ttf'),
      ]);

      if (!resReg.ok || !resBold.ok) {
        throw new Error(`HTTP fetch failed (Regular: ${resReg.status}, Bold: ${resBold.status})`);
      }

      const [bufReg, bufBold] = await Promise.all([
        resReg.arrayBuffer(),
        resBold.arrayBuffer(),
      ]);

      cachedFontRegularBase64 = arrayBufferToBase64(bufReg);
      cachedFontBoldBase64 = arrayBufferToBase64(bufBold);
    } catch (err) {
      cachedFontRegularBase64 = null;
      cachedFontBoldBase64 = null;
      throw new Error(`Failed to load authoritative Noto Sans fonts for PDF export: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  doc.addFileToVFS('NotoSans-Regular.ttf', cachedFontRegularBase64);
  doc.addFont('NotoSans-Regular.ttf', 'EgatepassNoto', 'normal');
  doc.addFileToVFS('NotoSans-Bold.ttf', cachedFontBoldBase64);
  doc.addFont('NotoSans-Bold.ttf', 'EgatepassNoto', 'bold');
  doc.setFont('EgatepassNoto', 'normal');
}

/**
 * Test-only hook to reset cached base64 font representations.
 * Never to be invoked in production application runtime.
 */
export function __resetCachedPdfFontsForTests(): void {
  cachedFontRegularBase64 = null;
  cachedFontBoldBase64 = null;
}

/**
 * Human-readable Institutional PDF export using jsPDF and jspdf-autotable
 */
export async function exportReportToPdf<T>(options: ReportExportOptions<T>): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTableModule = await import('jspdf-autotable');
  const autoTableFn = (autoTableModule as any).default || (autoTableModule as any).autoTable;

  const reportTitle = options.reportTitle ?? options.title ?? 'Report';
  const isWide = options.orientation ? options.orientation === 'landscape' : options.columns.length > 5;
  const doc = new jsPDF({
    orientation: isWide ? 'landscape' : 'portrait',
    unit: 'pt',
    format: 'a4',
  });

  await loadNotoPdfFonts(doc);

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  // 1. Institutional Header Banner
  doc.setFillColor(128, 0, 0); // #800000 Maroon
  doc.rect(0, 0, pageWidth, 45, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont('EgatepassNoto', 'bold');
  doc.text('EARIST E-GATEPASS', 24, 28);

  doc.setFontSize(9);
  doc.setFont('EgatepassNoto', 'normal');
  doc.text('Institutional Security & Visitor Records', pageWidth - 24, 28, { align: 'right' });

  // 2. Report Information
  doc.setTextColor(24, 24, 27);
  doc.setFontSize(14);
  doc.setFont('EgatepassNoto', 'bold');
  doc.text(reportTitle, 24, 70);

  doc.setFontSize(9);
  doc.setFont('EgatepassNoto', 'normal');
  doc.setTextColor(82, 82, 91);
  const metaTime = options.generatedAt || formatManilaDateTime(new Date());
  doc.text(`Generated: ${metaTime}  •  By: ${options.generatedBy || 'Authorized Staff'}`, 24, 85);

  let startY = 95;
  if (options.filterMetadata) {
    const filterStrings = Object.entries(options.filterMetadata)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}: ${v}`);
    if (filterStrings.length > 0) {
      doc.text(`Applied Filters: ${filterStrings.join(' | ')}`, 24, 98);
      startY = 108;
    }
  }

  // 3. Paginated Data Table
  const headers = options.columns.map((c) => c.header);
  const data = options.rows.map((row) => options.columns.map((col) => getCellValue(row, col)));

  const tableOptions = {
    head: [headers],
    body: data,
    startY,
    margin: { left: 24, right: 24, bottom: 40 },
    theme: 'striped',
    styles: {
      font: 'EgatepassNoto',
    },
    headStyles: {
      font: 'EgatepassNoto',
      fillColor: [128, 0, 0] as [number, number, number],
      textColor: [255, 255, 255] as [number, number, number],
      fontStyle: 'bold',
      fontSize: 8,
    },
    bodyStyles: {
      font: 'EgatepassNoto',
      fontStyle: 'normal',
      fontSize: 8,
      cellPadding: 4,
    },
  };

  if (typeof (doc as any).autoTable === 'function') {
    (doc as any).autoTable(tableOptions);
  } else if (typeof autoTableFn === 'function') {
    autoTableFn(doc, tableOptions);
  }

  // Draw final institutional footer with accurate total page count on every page
  const totalPages = doc.getNumberOfPages();
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    doc.setPage(pageNumber);
    const pageStr = `Page ${pageNumber} of ${totalPages}`;
    doc.setFontSize(8);
    doc.setFont('EgatepassNoto', 'normal');
    doc.setTextColor(161, 161, 170);
    doc.text(pageStr, pageWidth - 24, pageHeight - 16, { align: 'right' });
    doc.text('Eulogio "Amang" Rodriguez Institute of Science and Technology • Confidential', 24, pageHeight - 16);
  }

  const blob = doc.output('blob');
  triggerDownload(blob, options.filename.endsWith('.pdf') ? options.filename : `${options.filename}.pdf`);
}
