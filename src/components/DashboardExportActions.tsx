import { useState } from 'react';
import { Download, FileSpreadsheet, FileText, Printer, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import { escapeCsvCell } from '@/lib/completeExport';
import {
  formatManilaDateTime,
  formatManilaFileTimestamp,
  formatManilaMonthYear,
  getManilaMonthKey,
} from '@/lib/manilaTime';
import {
  exportReportToCsv,
  exportReportToExcel,
  exportReportToPdf,
} from '@/lib/reportExport';
import {
  fetchDashboardReportData,
  type DashboardPeriodQuery,
} from '@/hooks/useAdminDashboardData';
import type { GatePass } from '@/types';

export interface DashboardReportSummary {
  visitorsToday: number;
  monthTotal?: number;
  currentlyInside: number;
  exitedToday: number;
  pendingApproval: number;
  rejectedToday: number;
  insights: Array<{
    title: string;
    value: string;
    count: number;
    description: string;
  }>;
}

export interface DashboardExportTruncationInfo {
  truncated: boolean;
  totalMatchingCount: number;
  offlineTotalCount: number;
  maxRows: number;
  offlineTruncated: boolean;
}

interface DashboardExportActionsProps {
  passes: GatePass[];
  summary: DashboardReportSummary;
  periodQuery?: DashboardPeriodQuery;
  periodLabel?: string;
  showCompleteFormats?: boolean;
  onReportTruncation?: (info: DashboardExportTruncationInfo | null) => void;
}

const reportColumns = [
  'Visitor name',
  'Pass issued',
  'Purpose',
  'Entry gate',
  'Status',
  'Scanned at',
  'Time in',
  'Time out',
  'Rejection reason',
  'Source',
] as const;

function formatTimestamp(timestamp: GatePass['issuedAt'] | null): string {
  return timestamp ? formatManilaDateTime(timestamp.toDate()) : 'Not recorded';
}

function formatLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function reportRows(passes: GatePass[]): string[][] {
  return [...passes]
    .sort((a, b) => b.issuedAt.toMillis() - a.issuedAt.toMillis())
    .map((pass) => [
      pass.visitorName,
      formatTimestamp(pass.issuedAt),
      pass.purpose,
      pass.gate || 'Not assigned',
      formatLabel(pass.status),
      formatTimestamp(pass.scannedAt),
      formatTimestamp(pass.timeIn),
      formatTimestamp(pass.timeOut),
      pass.rejectionReason || 'None',
      formatLabel(pass.source),
    ]);
}

function passesForMonth(passes: GatePass[], reportDate: Date): GatePass[] {
  const targetKey = getManilaMonthKey(reportDate);
  return passes.filter((pass) => getManilaMonthKey(pass.issuedAt.toDate()) === targetKey);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[character] || character);
}

function downloadCsv(passes: GatePass[], summary: DashboardReportSummary) {
  const exportedAt = new Date();
  const monthLabel = formatManilaMonthYear(exportedAt);
  const monthlyPasses = passesForMonth(passes, exportedAt);
  const totalCount = summary.monthTotal ?? monthlyPasses.length;
  const summaryRows = [
    ['E-GatePass Dashboard Report'],
    ['Reporting month', monthLabel],
    ['Downloaded on', formatManilaDateTime(exportedAt)],
    ['Total passes issued this month (authoritative)', String(totalCount)],
    [],
    ['Dashboard Summary', 'Value'],
    ['Visitors today', String(summary.visitorsToday)],
    ['Currently inside', String(summary.currentlyInside)],
    ['Exited today', String(summary.exitedToday)],
    ['Pending approval', String(summary.pendingApproval)],
    ['Rejected today', String(summary.rejectedToday)],
  ];
  const insightRows = [
    ["Today's Insights (Authoritative)", 'Result', 'Records', 'Description'],
    ...summary.insights.map((insight) => [
      insight.title,
      insight.value,
      String(insight.count),
      insight.description,
    ]),
  ];
  const csv = [
    ...summaryRows,
    [],
    ...insightRows,
    [],
    [`${monthLabel} Recent Sample Records (Showing ${monthlyPasses.length} of ${totalCount} total; use Visitor Records for complete historical export)`],
    [...reportColumns],
    ...reportRows(monthlyPasses),
  ]
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `e-gatepass-${getManilaMonthKey(exportedAt)}-report.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function printReport(passes: GatePass[], summary: DashboardReportSummary) {
  const printedAt = new Date();
  const monthLabel = formatManilaMonthYear(printedAt);
  const monthlyPasses = passesForMonth(passes, printedAt);
  const rows = reportRows(monthlyPasses)
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  const summaryRows: Array<[string, string]> = [
    ['Visitors today', String(summary.visitorsToday)],
    ['Currently inside', String(summary.currentlyInside)],
    ['Exited today', String(summary.exitedToday)],
    ['Pending approval', String(summary.pendingApproval)],
    ['Rejected today', String(summary.rejectedToday)],
  ];
  const summaryMarkup = summaryRows.map(([label, value]) => `<div class="summary-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  const insightsMarkup = summary.insights.map((insight) => `
    <article class="insight">
      <h3>${escapeHtml(insight.title)}</h3>
      <strong>${escapeHtml(insight.value)}</strong>
      <span>${insight.count > 0 ? `${insight.count} record${insight.count === 1 ? '' : 's'}` : 'No records today'}</span>
      <p>${escapeHtml(insight.description)}</p>
    </article>
  `).join('');

  const totalCount = summary.monthTotal ?? monthlyPasses.length;
  const reportHtml = `<!doctype html><html><head><meta charset="utf-8"><title>E-GatePass Dashboard Report</title><style>
    @page { size: landscape; margin: 14mm; } body { color: #172033; font: 12px Arial, sans-serif; } h1 { margin: 0; font-size: 24px; } h2 { font-size: 16px; margin: 22px 0 10px; } .meta { color: #59657a; margin: 6px 0 20px; } .summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; } .summary-item, .insight { border: 1px solid #d8dee8; border-radius: 6px; padding: 10px; } .summary-item span, .insight span { display: block; color: #59657a; font-size: 10px; margin-bottom: 5px; } .insights { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; } .insight h3 { color: #8c1515; font-size: 11px; margin: 0 0 8px; } .insight strong { display: block; font-size: 16px; margin-bottom: 4px; } .insight p { color: #59657a; font-size: 10px; line-height: 1.4; margin: 8px 0 0; } table { border-collapse: collapse; width: 100%; } th { background: #8c1515; color: white; text-align: left; } th, td { border: 1px solid #d8dee8; padding: 7px; vertical-align: top; } td { word-break: break-word; } @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } tr, .summary-item, .insight { break-inside: avoid; } }
  </style></head><body><h1>E-GatePass Dashboard Report</h1><p class="meta"><strong>Reporting month:</strong> ${escapeHtml(monthLabel)}<br><strong>Printed on:</strong> ${escapeHtml(formatManilaDateTime(printedAt))}<br><strong>Total issued this month:</strong> ${totalCount}<br><strong>Detailed rows shown:</strong> recent sample ${monthlyPasses.length} of ${totalCount} (use Visitor Records for full historical export)</p><section class="summary">${summaryMarkup}</section><h2>Today's Insights</h2><section class="insights">${insightsMarkup}</section><h2>${escapeHtml(monthLabel)} Pass Details (Recent Sample)</h2><table><thead><tr>${reportColumns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${reportColumns.length}">No passes were issued in ${escapeHtml(monthLabel)}.</td></tr>`}</tbody></table></body></html>`;

  const printFrame = document.createElement('iframe');
  printFrame.title = 'Printable E-GatePass dashboard report';
  printFrame.style.position = 'fixed';
  printFrame.style.right = '0';
  printFrame.style.bottom = '0';
  printFrame.style.width = '1px';
  printFrame.style.height = '1px';
  printFrame.style.border = '0';
  printFrame.style.opacity = '0';
  printFrame.srcdoc = reportHtml;
  printFrame.onload = () => {
    const reportWindow = printFrame.contentWindow;
    if (!reportWindow) {
      printFrame.remove();
      return;
    }
    reportWindow.addEventListener('afterprint', () => printFrame.remove(), { once: true });
    reportWindow.focus();
    reportWindow.print();
  };
  document.body.appendChild(printFrame);
}

export function DashboardExportActions({
  passes,
  summary,
  periodQuery,
  periodLabel,
  showCompleteFormats = false,
  onReportTruncation,
}: DashboardExportActionsProps) {
  const [exportingFormat, setExportingFormat] = useState<'csv' | 'xlsx' | 'pdf' | 'offline' | null>(null);

  async function handleCompleteExport(format: 'csv' | 'xlsx' | 'pdf') {
    if (!periodQuery) {
      if (format === 'csv') downloadCsv(passes, summary);
      return;
    }
    setExportingFormat(format);
    try {
      const payload = await fetchDashboardReportData(periodQuery);
      onReportTruncation?.({
        truncated: payload.truncated,
        totalMatchingCount: payload.totalMatchingCount,
        offlineTotalCount: payload.offlineTotalCount,
        maxRows: payload.maxRows,
        offlineTruncated: Boolean(payload.offlineModeMetrics?.truncated),
      });

      const resolvedLabel = payload.periodMeta?.label || periodLabel || periodQuery.period;
      const timestamp = formatManilaFileTimestamp(new Date());
      const filename = `egatepass-dashboard-${periodQuery.period}-${timestamp}`;
      const columns = [
        { header: 'Visitor Name', key: 'visitorName', width: 24 },
        { header: 'Purpose', key: 'purpose', width: 32 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Source', key: 'source', width: 14 },
        { header: 'Gate', key: 'gate', width: 14 },
        { header: 'Issued At (Manila)', key: 'issuedAt', width: 22 },
        { header: 'Scanned At (Manila)', key: 'scannedAt', width: 22 },
        { header: 'Time In (Manila)', key: 'timeIn', width: 22 },
        { header: 'Time Out (Manila)', key: 'timeOut', width: 22 },
        { header: 'Rejection Reason', key: 'rejectionReason', width: 28 },
      ];
      const rows = payload.passes.map((p) => ({
        visitorName: p.visitorName,
        purpose: p.purpose,
        status: formatLabel(p.status),
        source: formatLabel(p.source),
        gate: p.gate || 'Not assigned',
        issuedAt: formatTimestamp(p.issuedAt),
        scannedAt: formatTimestamp(p.scannedAt),
        timeIn: formatTimestamp(p.timeIn),
        timeOut: formatTimestamp(p.timeOut),
        rejectionReason: p.rejectionReason || '',
      }));

      const commonOptions = {
        reportTitle: 'Institutional Visitor Pass Report',
        sheetName: 'Visitor Passes',
        filename,
        columns,
        rows,
        filterMetadata: {
          Period: resolvedLabel,
          Timezone: 'Asia/Manila (+08:00)',
          'Matching QR Passes': String(payload.totalMatchingCount),
          'OFFLINE MODE RECORDED (Isolated)': String(payload.offlineTotalCount),
          ...(payload.truncated ? { Truncated: `First ${payload.maxRows} of ${payload.totalMatchingCount} rows` } : {}),
        },
        totalRecords: payload.totalMatchingCount,
      };

      if (format === 'csv') {
        await exportReportToCsv(commonOptions);
      } else if (format === 'xlsx') {
        await exportReportToExcel(commonOptions);
      } else {
        await exportReportToPdf(commonOptions);
      }

      if (payload.truncated) {
        toast.warning(`Exported first ${payload.maxRows} of ${payload.totalMatchingCount} matching QR pass records. Narrow the period filter for complete results.`);
      } else {
        toast.success(`Exported ${rows.length} QR pass record${rows.length === 1 ? '' : 's'} (${format.toUpperCase()}).`);
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to export dashboard report');
    } finally {
      setExportingFormat(null);
    }
  }

  async function handleExportOfflineCsv() {
    if (!periodQuery) return;
    setExportingFormat('offline');
    try {
      const payload = await fetchDashboardReportData(periodQuery);
      onReportTruncation?.({
        truncated: payload.truncated,
        totalMatchingCount: payload.totalMatchingCount,
        offlineTotalCount: payload.offlineTotalCount,
        maxRows: payload.maxRows,
        offlineTruncated: Boolean(payload.offlineModeMetrics?.truncated),
      });
      const resolvedLabel = payload.periodMeta?.label || periodLabel || periodQuery.period;
      const timestamp = formatManilaFileTimestamp(new Date());
      await exportReportToCsv({
        reportTitle: 'Offline Mode Recorded Gate Intake Report',
        filename: `egatepass-offline-mode-recorded-${periodQuery.period}-${timestamp}`,
        columns: [
          { header: 'Classification', key: 'classification', width: 24 },
          { header: 'Gate', key: 'gate', width: 14 },
          { header: 'Local Seq', key: 'localSequence', width: 10 },
          { header: 'Visitor Name', key: 'visitorName', width: 24 },
          { header: 'Declared Address', key: 'declaredAddress', width: 32 },
          { header: 'Address Status', key: 'addressStatus', width: 16 },
          { header: 'Purpose', key: 'purpose', width: 28 },
          { header: 'Destination Office', key: 'officeName', width: 24 },
          { header: 'ID Physically Inspected', key: 'idPhysicallyInspected', width: 18 },
          { header: 'Emergency Exception', key: 'emergencyExceptionApplied', width: 18 },
          { header: 'Reconciliation Status', key: 'reconciliationStatus', width: 18 },
          { header: 'Local Recorded At (Manila)', key: 'localRecordedAt', width: 22 },
          { header: 'Server Synced At (Manila)', key: 'serverReceivedAt', width: 22 },
        ],
        rows: payload.offlineRecords.map((r) => ({
          ...r,
          idPhysicallyInspected: r.idPhysicallyInspected ? 'Yes' : 'No',
          emergencyExceptionApplied: r.emergencyExceptionApplied ? 'Yes' : 'No',
          localRecordedAt: formatManilaDateTime(r.localRecordedAt),
          serverReceivedAt: formatManilaDateTime(r.serverReceivedAt),
        })),
        filterMetadata: {
          Period: resolvedLabel,
          Classification: 'OFFLINE MODE RECORDED (Never auto-converted to QR pass)',
        },
      });
      if (payload.offlineModeMetrics?.truncated) {
        toast.warning(`Offline export capped at ${payload.maxRows} of ${payload.offlineTotalCount} rows.`);
      } else {
        toast.success(`Exported ${payload.offlineRecords.length} OFFLINE MODE RECORDED record${payload.offlineRecords.length === 1 ? '' : 's'}.`);
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to export offline records');
    } finally {
      setExportingFormat(null);
    }
  }

  return (
    <div className="flex flex-wrap gap-2" aria-label="Export dashboard data">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        icon={<Printer className="h-4 w-4" />}
        onClick={() => printReport(passes, summary)}
      >
        Print Report
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        icon={<Download className="h-4 w-4" />}
        loading={exportingFormat === 'csv'}
        disabled={exportingFormat !== null}
        onClick={() => (periodQuery ? void handleCompleteExport('csv') : downloadCsv(passes, summary))}
      >
        Download CSV
      </Button>
      {showCompleteFormats && periodQuery && (
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<FileSpreadsheet className="h-4 w-4" />}
            loading={exportingFormat === 'xlsx'}
            disabled={exportingFormat !== null}
            onClick={() => void handleCompleteExport('xlsx')}
          >
            Export Excel (.xlsx)
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<FileText className="h-4 w-4" />}
            loading={exportingFormat === 'pdf'}
            disabled={exportingFormat !== null}
            onClick={() => void handleCompleteExport('pdf')}
          >
            Export PDF
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<ShieldAlert className="h-4 w-4 text-amber-700" />}
            loading={exportingFormat === 'offline'}
            disabled={exportingFormat !== null}
            onClick={() => void handleExportOfflineCsv()}
          >
            Export Offline Mode CSV
          </Button>
        </>
      )}
    </div>
  );
}
