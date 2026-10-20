import { Download, Printer } from 'lucide-react';
import { format, isSameMonth } from 'date-fns';
import { Button } from '@/components/ui';
import type { GatePass } from '@/types';

export interface DashboardReportSummary {
  visitorsToday: number;
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

interface DashboardExportActionsProps {
  passes: GatePass[];
  summary: DashboardReportSummary;
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
  return timestamp ? format(timestamp.toDate(), 'MMM d, yyyy h:mm a') : 'Not recorded';
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

function passesForMonth(passes: GatePass[], month: Date): GatePass[] {
  return passes.filter((pass) => isSameMonth(pass.issuedAt.toDate(), month));
}

function escapeCsv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
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
  const monthLabel = format(exportedAt, 'MMMM yyyy');
  const monthlyPasses = passesForMonth(passes, exportedAt);
  const summaryRows = [
    ['E-GatePass Dashboard Report'],
    ['Reporting month', monthLabel],
    ['Downloaded on', format(exportedAt, 'MMMM d, yyyy h:mm a')],
    ['Passes issued', String(monthlyPasses.length)],
    [],
    ['Dashboard Summary', 'Value'],
    ['Visitors today', String(summary.visitorsToday)],
    ['Currently inside', String(summary.currentlyInside)],
    ['Exited today', String(summary.exitedToday)],
    ['Pending approval', String(summary.pendingApproval)],
    ['Rejected today', String(summary.rejectedToday)],
  ];
  const insightRows = [
    ["Today's Insights", 'Result', 'Records', 'Description'],
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
    [`${monthLabel} Pass Details`],
    [...reportColumns],
    ...reportRows(monthlyPasses),
  ]
    .map((row) => row.map(escapeCsv).join(','))
    .join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `e-gatepass-${format(exportedAt, 'yyyy-MM')}-report.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function printReport(passes: GatePass[], summary: DashboardReportSummary) {
  const printedAt = new Date();
  const monthLabel = format(printedAt, 'MMMM yyyy');
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

  const reportHtml = `<!doctype html><html><head><title>E-GatePass Dashboard Report</title><style>
    @page { size: landscape; margin: 14mm; } body { color: #172033; font: 12px Arial, sans-serif; } h1 { margin: 0; font-size: 24px; } h2 { font-size: 16px; margin: 22px 0 10px; } .meta { color: #59657a; margin: 6px 0 20px; } .summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; } .summary-item, .insight { border: 1px solid #d8dee8; border-radius: 6px; padding: 10px; } .summary-item span, .insight span { display: block; color: #59657a; font-size: 10px; margin-bottom: 5px; } .insights { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; } .insight h3 { color: #8c1515; font-size: 11px; margin: 0 0 8px; } .insight strong { display: block; font-size: 16px; margin-bottom: 4px; } .insight p { color: #59657a; font-size: 10px; line-height: 1.4; margin: 8px 0 0; } table { border-collapse: collapse; width: 100%; } th { background: #8c1515; color: white; text-align: left; } th, td { border: 1px solid #d8dee8; padding: 7px; vertical-align: top; } td { word-break: break-word; } @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } tr, .summary-item, .insight { break-inside: avoid; } }
  </style></head><body><h1>E-GatePass Dashboard Report</h1><p class="meta"><strong>Reporting month:</strong> ${escapeHtml(monthLabel)}<br><strong>Printed on:</strong> ${escapeHtml(format(printedAt, 'MMMM d, yyyy h:mm a'))}<br><strong>Passes issued:</strong> ${monthlyPasses.length}</p><section class="summary">${summaryMarkup}</section><h2>Today's Insights</h2><section class="insights">${insightsMarkup}</section><h2>${escapeHtml(monthLabel)} Pass Details</h2><table><thead><tr>${reportColumns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${reportColumns.length}">No passes were issued in ${escapeHtml(monthLabel)}.</td></tr>`}</tbody></table></body></html>`;

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

export function DashboardExportActions({ passes, summary }: DashboardExportActionsProps) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Export dashboard data">
      <Button type="button" variant="secondary" size="sm" icon={<Printer className="h-4 w-4" />} onClick={() => printReport(passes, summary)}>
        Print Report
      </Button>
      <Button type="button" variant="secondary" size="sm" icon={<Download className="h-4 w-4" />} onClick={() => downloadCsv(passes, summary)}>
        Download CSV
      </Button>
    </div>
  );
}
