import { useState, useEffect } from 'react';
import { AlertTriangle, Printer } from 'lucide-react';
import { formatManilaDateTime, formatManilaTime } from '@/lib/manilaTime';
import { Card, Input, Select, Button, DataTable, DataTableHead, DataTableRow, DataTableCell, StatusBadge } from '@/components/ui';
import { getAccessToken } from '@/services/auth';

interface EmergencyEvacuationPass {
  id: string;
  visitorId: string;
  visitorName: string;
  purpose: string;
  gate: string | null;
  timeIn: string | null;
  issuedAt: string | null;
  status: 'inside';
}

export function AdminEmergency() {
  const [passes, setPasses] = useState<EmergencyEvacuationPass[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gateFilter, setGateFilter] = useState('');
  const [search, setSearch] = useState('');
  const [isTruncated, setIsTruncated] = useState(false);

  // Extract unique gates from passes
  const gates = Array.from(new Set(passes.map((p) => p.gate).filter(Boolean))) as string[];

  async function loadEmergencyPasses() {
    try {
      setLoadError(null);
      const token = await getAccessToken();
      const response = await fetch('/api/admin/emergency', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => null) as { passes?: EmergencyEvacuationPass[]; truncated?: boolean; error?: string } | null;
      if (!response.ok) throw new Error(data?.error || 'Failed to load evacuation list');

      setPasses(data?.passes ?? []);
      setIsTruncated(Boolean(data?.truncated));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load evacuation list';
      setLoadError(msg);
      console.error('Emergency load error:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadEmergencyPasses();
    const timer = setInterval(() => {
      void loadEmergencyPasses();
    }, 15_000);
    return () => clearInterval(timer);
  }, []);

  const filteredPasses = passes.filter((p) => {
    if (gateFilter && p.gate !== gateFilter) return false;
    if (search && !(p.visitorName ?? '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="space-y-6 print:m-0 print:p-0">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between print:hidden">
        <div>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-[var(--color-danger)]" />
            <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
              Emergency Evacuation List
            </h1>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--color-text-secondary)]">
            Use this list during an emergency to see which visitors are still inside the premises. Search or filter the list, then print it to help account for everyone during evacuation.
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--color-danger)]">
            Currently Inside: {passes.length} Visitors
          </p>
        </div>
        <Button
          onClick={() => window.print()}
          variant="secondary"
          icon={<Printer className="h-4 w-4" />}
        >
          Print Roll Call
        </Button>
      </div>

      {/* Screen Incompleteness Alert Banner (C-02) */}
      {isTruncated && (
        <div className="rounded-lg border-2 border-red-500 bg-red-50 p-4 text-red-900 shadow-sm print:hidden" role="alert">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-6 w-6 flex-shrink-0 text-red-600" />
            <div>
              <h3 className="text-sm font-bold uppercase tracking-wide">Warning: Evacuation List Truncated</h3>
              <p className="mt-1 text-xs leading-relaxed">
                The safety query ceiling (10,000 records) was reached. Showing the first {passes.length.toLocaleString()} inside visitors. Additional visitors may be inside the premises. Immediately check physical gate logs.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Screen Load Error Banner (C-02) */}
      {loadError && (
        <div className="rounded-lg border-2 border-red-500 bg-red-50 p-4 text-red-900 print:hidden" role="alert">
          <p className="font-bold text-sm">Failed to refresh live evacuation list: {loadError}</p>
          <p className="text-xs mt-1">Do not rely on stale evacuation counts during active incidents. Verify manual gate logs.</p>
        </div>
      )}

      {/* Print Header (Visible only in print) */}
      <div className="hidden print:block mb-4">
        <h1 className="text-2xl font-bold text-black mb-1">EARIST Emergency Roll Call</h1>
        <p className="text-sm font-medium text-black">
          Generated: {formatManilaDateTime(new Date(), { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })} (Asia/Manila)
        </p>
        <p className="text-sm font-medium text-black">
          Total Visitors Listed Inside: {filteredPasses.length}
        </p>
      </div>

      {/* Print Incompleteness Warning Banner (Visible only in print) */}
      {isTruncated && (
        <div className="hidden print:block border-4 border-black p-3 mb-4 text-black bg-white">
          <p className="font-extrabold text-base uppercase tracking-wider">
            *** CRITICAL WARNING: EVACUATION LIST INCOMPLETE / TRUNCATED ***
          </p>
          <p className="text-xs font-bold mt-1">
            Safety ceiling of 10,000 records reached. Do NOT assume all visitors are listed. Reconcile with manual gate logs immediately.
          </p>
        </div>
      )}

      {/* Print Error Warning Banner (Visible only in print) */}
      {loadError && (
        <div className="hidden print:block border-4 border-black p-3 mb-4 text-black bg-white">
          <p className="font-extrabold text-base uppercase tracking-wider">
            *** CRITICAL WARNING: DATA REFRESH FAILED — ROSTER MAY BE STALE ***
          </p>
          <p className="text-xs font-bold mt-1">
            Error: {loadError}
          </p>
        </div>
      )}

      <Card className="flex flex-wrap gap-4 p-5 print:hidden">
        <div className="min-w-0 flex-1 sm:min-w-52">
          <label htmlFor="emergency-visitor-search" className="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">Search Name</label>
          <Input
            id="emergency-visitor-search"
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        
        <div className="w-full sm:w-48">
          <label className="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">Filter by Entry Gate</label>
          <Select
            value={gateFilter}
            onChange={(e) => setGateFilter(e.target.value)}
            aria-label="Filter by entry gate"
          >
            <option value="">All Gates</option>
            {gates.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </Select>
        </div>
      </Card>

      {/* Table */}
      <div className="print:border-none print:shadow-none print:m-0 print:p-0">
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableCell isHeader className="print:px-2 print:text-black">Visitor Name</DataTableCell>
              <DataTableCell isHeader className="print:px-2 print:text-black">Time In</DataTableCell>
              <DataTableCell isHeader className="print:px-2 print:text-black">Entry Gate</DataTableCell>
              <DataTableCell isHeader className="print:px-2 print:text-black">Status</DataTableCell>
              <DataTableCell isHeader className="print:w-20 print:text-black">Accounted</DataTableCell>
            </DataTableRow>
          </DataTableHead>
          <tbody className="divide-y border-[var(--color-border)] print:divide-black/20">
            {loading ? (
              <tr className="print:hidden">
                <td colSpan={5} className="py-12 text-center">
                  <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-danger)]" role="status" aria-label="Loading evacuation list" />
                </td>
              </tr>
            ) : filteredPasses.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-[var(--color-text-muted)] print:text-black">
                  No visitors currently inside.
                </td>
              </tr>
            ) : (
              filteredPasses.map((pass) => (
                <DataTableRow key={pass.id as string} className="print:hover:bg-transparent">
                  <DataTableCell className="font-bold print:px-2">{pass.visitorName}</DataTableCell>
                  <DataTableCell className="print:px-2">
                    {pass.timeIn ? formatManilaTime(pass.timeIn) : '—'}
                  </DataTableCell>
                  <DataTableCell className="print:px-2">{pass.gate || 'Unknown'}</DataTableCell>
                  <DataTableCell className="print:px-2 print:text-black"><StatusBadge status="inside" label="Inside" /></DataTableCell>
                  <DataTableCell className="print:px-2">
                    {/* Checkbox for physical printout marking */}
                    <div className="h-6 w-6 rounded border-2 border-[var(--color-border)] print:border-black" />
                  </DataTableCell>
                </DataTableRow>
              ))
            )}
          </tbody>
        </DataTable>
      </div>
    </div>
  );
}
