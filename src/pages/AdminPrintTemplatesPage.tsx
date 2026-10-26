import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { isSuperAdmin } from '@/lib/permissions';
import { requireSupabase } from '@/lib/supabase';
import { toast } from 'sonner';
import { Button, Card } from '@/components/ui';
import {
  Printer,
  Save,
  CheckCircle2,
  RotateCcw,
  Plus,
  Trash2,
  Lock,
  Eye,
  History,
  AlertTriangle,
  Sliders,
  Type,
  Maximize2,
  Loader2,
} from 'lucide-react';
import type {
  ThermalTemplateLayout,
  ThermalElement,
} from '@/types/thermalTemplate';
import {
  MANDATORY_ELEMENT_TYPES,
  validateThermalTemplateLayout,
} from '@/types/thermalTemplate';
import { BUNDLED_DEFAULT_THERMAL_TEMPLATE } from '@/printer/templates/bundledDefaultTemplate';

interface TemplateVersionRecord {
  id: string;
  name: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  layout: ThermalTemplateLayout;
  published_at?: string | null;
  created_at: string;
}

export function AdminPrintTemplatesPage() {
  const { role } = useAuth();
  const isSuper = isSuperAdmin(role);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const [templateName, setTemplateName] = useState('Default Institutional 384px Template');
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [currentStatus, setCurrentStatus] = useState<'draft' | 'published' | 'archived'>('published');
  const [layout, setLayout] = useState<ThermalTemplateLayout>(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
  const [versions, setVersions] = useState<TemplateVersionRecord[]>([]);

  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'editor' | 'versions'>('editor');

  const canvasRef = useRef<HTMLDivElement>(null);

  // 1. Load templates from Supabase
  async function loadTemplates() {
    setLoading(true);
    try {
      const client = requireSupabase();
      const { data, error } = await client
        .from('thermal_templates')
        .select('*')
        .order('version', { ascending: false });

      if (error) throw error;

      if (data && data.length > 0) {
        setVersions(data as TemplateVersionRecord[]);
        // Find current published or latest draft
        const published = data.find((t) => t.status === 'published') || data[0];
        setTemplateName(published.name);
        setCurrentVersion(published.version);
        setCurrentStatus(published.status as any);
        if (published.layout && typeof published.layout === 'object' && published.layout.width === 384) {
          setLayout(published.layout);
        }
      } else {
        setLayout(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
      }
    } catch (err) {
      console.error('Failed to load thermal templates:', err);
      toast.error('Could not load thermal templates. Using default template.');
      setLayout(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isSuper) {
      void loadTemplates();
    }
  }, [isSuper]);

  if (!isSuper) {
    return (
      <main id="main-content" className="p-8 text-center" role="alert">
        <AlertTriangle className="mx-auto h-12 w-12 text-[var(--color-danger)] mb-4" />
        <h1 className="text-xl font-bold text-[var(--color-text-primary)]">Access Denied</h1>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
          Only Super Administrators are authorized to design, edit, or publish thermal pass templates.
        </p>
      </main>
    );
  }

  const selectedElement = layout.elements.find((el) => el.id === selectedElementId) || null;

  // Element property updates
  function updateElement(id: string, partial: Partial<ThermalElement>) {
    setLayout((prev) => ({
      ...prev,
      elements: prev.elements.map((el) => (el.id === id ? { ...el, ...partial } : el)),
    }));
  }

  // Add static element (divider, text, rectangle)
  function handleAddElement(type: 'text' | 'divider' | 'rectangle') {
    const newId = `elem-${Date.now().toString(36)}`;
    let newElement: ThermalElement;

    if (type === 'divider') {
      newElement = {
        id: newId,
        type: 'divider',
        label: 'Divider Line',
        x: 20,
        y: Math.min(layout.height, 200),
        width: 344,
        height: 1,
        isMandatory: false,
      };
    } else if (type === 'rectangle') {
      newElement = {
        id: newId,
        type: 'rectangle',
        label: 'Box Border',
        x: 20,
        y: Math.min(layout.height, 200),
        width: 344,
        height: 60,
        isMandatory: false,
      };
    } else {
      newElement = {
        id: newId,
        type: 'text',
        field: 'custom',
        label: 'Custom Text',
        x: 192,
        y: Math.min(layout.height, 200),
        width: 200,
        height: 24,
        fontSize: 11,
        fontWeight: 'normal',
        align: 'center',
        text: 'Custom Text Notice',
        isMandatory: false,
      };
    }

    setLayout((prev) => ({
      ...prev,
      elements: [...prev.elements, newElement],
    }));
    setSelectedElementId(newId);
  }

  // Delete element (only if not locked/mandatory)
  function handleDeleteElement(id: string) {
    const elem = layout.elements.find((e) => e.id === id);
    if (!elem) return;

    const isMandatory =
      elem.isMandatory ||
      elem.isLocked ||
      elem.isRequired ||
      MANDATORY_ELEMENT_TYPES.includes((elem.field || elem.type) as string);

    if (isMandatory) {
      toast.error('Mandatory institutional elements cannot be deleted.');
      return;
    }

    setLayout((prev) => ({
      ...prev,
      elements: prev.elements.filter((e) => e.id !== id),
    }));
    if (selectedElementId === id) setSelectedElementId(null);
  }

  // Canvas height update
  function handleCanvasHeightChange(newHeight: number) {
    const bounded = Math.max(300, Math.min(800, newHeight));
    setLayout((prev) => ({ ...prev, height: bounded, canvasHeight: bounded }));
  }

  // Save Draft RPC
  async function handleSaveDraft() {
    const valResult = validateThermalTemplateLayout(layout);
    if (!valResult.success) {
      toast.error(valResult.error.issues[0]?.message || 'Invalid layout');
      return;
    }

    setSaving(true);
    try {
      const client = requireSupabase();
      const { data, error } = await client.rpc('admin_save_thermal_template', {
        requested_name: templateName,
        requested_layout: layout,
        requested_version: currentStatus === 'draft' ? currentVersion : null,
      });

      if (error) throw error;
      toast.success(`Draft saved (v${data.version})`);
      await loadTemplates();
    } catch (err: any) {
      console.error('Save draft error:', err);
      toast.error(err.message || 'Failed to save draft template');
    } finally {
      setSaving(false);
    }
  }

  // Publish Template RPC
  async function handlePublish() {
    const valResult = validateThermalTemplateLayout(layout);
    if (!valResult.success) {
      toast.error(valResult.error.issues[0]?.message || 'Invalid layout');
      return;
    }

    setPublishing(true);
    try {
      const client = requireSupabase();
      // Ensure draft is saved first
      const saveRes = await client.rpc('admin_save_thermal_template', {
        requested_name: templateName,
        requested_layout: layout,
        requested_version: currentStatus === 'draft' ? currentVersion : null,
      });
      if (saveRes.error) throw saveRes.error;

      const targetVer = saveRes.data.version;
      const pubRes = await client.rpc('admin_publish_thermal_template', {
        requested_version: targetVer,
      });
      if (pubRes.error) throw pubRes.error;

      toast.success(`Template v${targetVer} published successfully! Active on kiosks.`);
      await loadTemplates();
    } catch (err: any) {
      console.error('Publish error:', err);
      toast.error(err.message || 'Failed to publish thermal template');
    } finally {
      setPublishing(false);
    }
  }

  // Restore previous version RPC
  async function handleRestoreVersion(versionNum: number) {
    setRestoring(true);
    try {
      const client = requireSupabase();
      const { data, error } = await client.rpc('admin_restore_thermal_template', {
        source_version: versionNum,
      });
      if (error) throw error;
      toast.success(`Restored from v${versionNum} (Published as v${data.version})`);
      await loadTemplates();
      setActiveTab('editor');
    } catch (err: any) {
      console.error('Restore error:', err);
      toast.error(err.message || 'Failed to restore template version');
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[var(--color-border)] pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Printer className="h-6 w-6 text-[#800000]" />
            <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
              Thermal Print Templates
            </h1>
          </div>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Design and publish high-contrast 384px monochrome layouts for the kiosk MXW01 thermal printer.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant={activeTab === 'editor' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('editor')}
            size="sm"
            icon={<Sliders className="h-4 w-4" />}
          >
            Visual Editor
          </Button>
          <Button
            variant={activeTab === 'versions' ? 'primary' : 'secondary'}
            onClick={() => setActiveTab('versions')}
            size="sm"
            icon={<History className="h-4 w-4" />}
          >
            Versions ({versions.length})
          </Button>
        </div>
      </div>

      {loading ? (
        <Card className="p-12 text-center text-sm text-[var(--color-text-secondary)] flex flex-col items-center justify-center gap-2">
          <Loader2 className="h-6 w-6 animate-spin text-[#800000]" />
          <span>Loading thermal print templates…</span>
        </Card>
      ) : activeTab === 'versions' ? (
        /* Version History View (Phase 3.4) */
        <Card className="p-6">
          <h2 className="text-lg font-bold text-[var(--color-text-primary)] mb-4">
            Template Version History
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] uppercase">
                <tr>
                  <th className="py-3 px-4">Version</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Name</th>
                  <th className="py-3 px-4">Published Date</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {versions.map((v) => (
                  <tr key={v.id} className="hover:bg-[var(--color-surface-hover)]">
                    <td className="py-3 px-4 font-mono font-bold">v{v.version}</td>
                    <td className="py-3 px-4">
                      {v.status === 'published' ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                          <CheckCircle2 className="h-3 w-3" /> Published
                        </span>
                      ) : v.status === 'draft' ? (
                        <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                          Draft
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                          Archived
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-[var(--color-text-primary)]">{v.name}</td>
                    <td className="py-3 px-4 text-xs text-[var(--color-text-muted)]">
                      {v.published_at ? new Date(v.published_at).toLocaleString() : '—'}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {v.status !== 'published' ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void handleRestoreVersion(v.version)}
                          disabled={restoring}
                          icon={<RotateCcw className="h-3.5 w-3.5" />}
                        >
                          Restore as Published
                        </Button>
                      ) : (
                        <span className="text-xs text-[var(--color-text-muted)] font-medium">
                          Active Version
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        /* Visual Editor View */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Controls Column (Left) */}
          <div className="lg:col-span-4 space-y-4">
            <Card className="p-4 space-y-4">
              <h2 className="text-base font-bold text-[var(--color-text-primary)] flex items-center justify-between">
                <span>Template Settings</span>
                <span className="text-xs font-mono font-normal text-[var(--color-text-muted)]">
                  {currentVersion ? `v${currentVersion} (${currentStatus})` : 'Draft'}
                </span>
              </h2>

              <div>
                <label className="block text-xs font-semibold text-[var(--color-text-secondary)] mb-1">
                  Template Name
                </label>
                <input
                  type="text"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-3 py-1.5 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[var(--color-text-secondary)] mb-1">
                  Canvas Height: {layout.height}px
                </label>
                <input
                  type="range"
                  min="320"
                  max="700"
                  step="20"
                  value={layout.height}
                  onChange={(e) => handleCanvasHeightChange(Number(e.target.value))}
                  className="w-full cursor-pointer accent-[#800000]"
                />
              </div>

              <div className="flex gap-2 pt-2 border-t border-[var(--color-border)]">
                <Button
                  onClick={handleSaveDraft}
                  disabled={saving || publishing}
                  loading={saving}
                  variant="secondary"
                  size="sm"
                  className="flex-1"
                  icon={<Save className="h-4 w-4" />}
                >
                  Save Draft
                </Button>
                <Button
                  onClick={handlePublish}
                  disabled={saving || publishing}
                  loading={publishing}
                  size="sm"
                  className="flex-1 bg-[#800000] hover:bg-[#660000]"
                  icon={<CheckCircle2 className="h-4 w-4" />}
                >
                  Publish Template
                </Button>
              </div>
            </Card>

            {/* Element Inspector */}
            <Card className="p-4 space-y-3">
              <h3 className="text-sm font-bold text-[var(--color-text-primary)] flex items-center justify-between">
                <span>Element Properties</span>
                {(selectedElement?.isMandatory || selectedElement?.isLocked || selectedElement?.isRequired) && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-300 font-semibold">
                    <Lock className="h-3 w-3" /> Mandatory
                  </span>
                )}
              </h3>

              {selectedElement ? (
                <div className="space-y-3 text-xs">
                  <div>
                    <label className="block font-medium text-[var(--color-text-secondary)] mb-1">
                      Label / Description
                    </label>
                    <input
                      type="text"
                      value={selectedElement.label || selectedElement.field || selectedElement.type}
                      onChange={(e) => updateElement(selectedElement.id, { label: e.target.value })}
                      className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2.5 py-1 text-xs"
                    />
                  </div>

                  {(selectedElement.type === 'text' || selectedElement.field === 'custom') && (
                    <div>
                      <label className="block font-medium text-[var(--color-text-secondary)] mb-1">
                        Text Content
                      </label>
                      <input
                        type="text"
                        value={selectedElement.text || ''}
                        onChange={(e) => updateElement(selectedElement.id, { text: e.target.value })}
                        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2.5 py-1 text-xs"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block font-medium text-[var(--color-text-secondary)] mb-1">
                        X (px)
                      </label>
                      <input
                        type="number"
                        min="0"
                        max="384"
                        value={selectedElement.x}
                        onChange={(e) => updateElement(selectedElement.id, { x: Number(e.target.value) })}
                        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-[var(--color-text-secondary)] mb-1">
                        Y (px)
                      </label>
                      <input
                        type="number"
                        min="0"
                        max={layout.height}
                        value={selectedElement.y}
                        onChange={(e) => updateElement(selectedElement.id, { y: Number(e.target.value) })}
                        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1 text-xs"
                      />
                    </div>
                  </div>

                  {selectedElement.fontSize !== undefined && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block font-medium text-[var(--color-text-secondary)] mb-1">
                          Font Size (px)
                        </label>
                        <input
                          type="number"
                          min="8"
                          max="36"
                          value={selectedElement.fontSize}
                          onChange={(e) =>
                            updateElement(selectedElement.id, { fontSize: Number(e.target.value) })
                          }
                          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1 text-xs"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-[var(--color-text-secondary)] mb-1">
                          Alignment
                        </label>
                        <select
                          value={selectedElement.align || 'center'}
                          onChange={(e) =>
                            updateElement(selectedElement.id, { align: e.target.value as any })
                          }
                          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1 text-xs"
                        >
                          <option value="left">Left</option>
                          <option value="center">Center</option>
                          <option value="right">Right</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {selectedElement.width !== undefined && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block font-medium text-[var(--color-text-secondary)] mb-1">
                          Width (px)
                        </label>
                        <input
                          type="number"
                          min="20"
                          max="384"
                          value={selectedElement.width}
                          onChange={(e) =>
                            updateElement(selectedElement.id, { width: Number(e.target.value) })
                          }
                          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1 text-xs"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-[var(--color-text-secondary)] mb-1">
                          Height (px)
                        </label>
                        <input
                          type="number"
                          min="1"
                          max="384"
                          value={selectedElement.height || 1}
                          onChange={(e) =>
                            updateElement(selectedElement.id, { height: Number(e.target.value) })
                          }
                          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1 text-xs"
                        />
                      </div>
                    </div>
                  )}

                  {!selectedElement.isMandatory && !selectedElement.isLocked && !selectedElement.isRequired && (
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <Button
                        size="sm"
                        variant="destructive-outline"
                        onClick={() => handleDeleteElement(selectedElement.id)}
                        className="w-full"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                      >
                        Delete Element
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-[var(--color-text-muted)] italic">
                  Select an element on the canvas to edit its position, font size, or dimensions.
                </p>
              )}
            </Card>

            {/* Add Static Elements */}
            <Card className="p-4 space-y-2">
              <h3 className="text-xs font-bold text-[var(--color-text-primary)] uppercase tracking-wide">
                Add Layout Elements
              </h3>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleAddElement('text')}
                  icon={<Type className="h-3 w-3" />}
                >
                  Text
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleAddElement('divider')}
                  icon={<Plus className="h-3 w-3" />}
                >
                  Divider
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleAddElement('rectangle')}
                  icon={<Maximize2 className="h-3 w-3" />}
                >
                  Box
                </Button>
              </div>
            </Card>
          </div>

          {/* Interactive Thermal Canvas (Right) */}
          <div className="lg:col-span-8 flex flex-col items-center">
            <div className="mb-2 text-xs text-[var(--color-text-secondary)] flex items-center gap-2">
              <Eye className="h-3.5 w-3.5" />
              <span>Native 384px thermal preview (1-bit monochrome)</span>
            </div>

            {/* 384px Canvas Simulation */}
            <div
              ref={canvasRef}
              className="relative rounded-lg border-4 border-zinc-800 bg-white shadow-2xl overflow-hidden select-none"
              style={{
                width: '384px',
                height: `${layout.height}px`,
                fontFamily: 'monospace, sans-serif',
              }}
            >
              {layout.elements.map((el) => {
                const isSelected = el.id === selectedElementId;
                let content: React.ReactNode = null;
                const field = el.field || (el.type as string);

                if (field === 'institution_name') {
                  content = (
                    <div
                      className="font-bold uppercase tracking-wider text-black"
                      style={{ fontSize: `${el.fontSize || 16}px`, textAlign: el.align || 'center' }}
                    >
                      EARIST E-GATEPASS
                    </div>
                  );
                } else if (field === 'visitor_name') {
                  content = (
                    <div
                      className="font-bold uppercase tracking-tight text-black"
                      style={{ fontSize: `${el.fontSize || 20}px`, textAlign: el.align || 'center' }}
                    >
                      JUAN DELA CRUZ
                    </div>
                  );
                } else if (field === 'visit_date') {
                  content = (
                    <div
                      className="font-semibold text-black"
                      style={{ fontSize: `${el.fontSize || 12}px`, textAlign: el.align || 'center' }}
                    >
                      Visit Date: Oct 27, 2026
                    </div>
                  );
                } else if (field === 'qr_code' || el.type === 'qr') {
                  const size = el.width || 210;
                  content = (
                    <div
                      className="border-2 border-black bg-white flex flex-col items-center justify-center p-2"
                      style={{ width: `${size}px`, height: `${size}px` }}
                    >
                      <div className="grid grid-cols-4 gap-1 w-full h-full p-2 bg-black/5">
                        <div className="bg-black col-span-1 row-span-1" />
                        <div className="bg-white col-span-2" />
                        <div className="bg-black col-span-1 row-span-1" />
                        <div className="bg-black col-span-2 row-span-2" />
                        <div className="bg-white col-span-1" />
                        <div className="bg-black col-span-1" />
                      </div>
                      <span className="text-[9px] font-mono font-bold mt-1 text-black">
                        [AUTHORITATIVE QR]
                      </span>
                    </div>
                  );
                } else if (field === 'pass_reference') {
                  content = (
                    <div
                      className="font-mono font-bold tracking-wider text-black"
                      style={{ fontSize: `${el.fontSize || 12}px`, textAlign: el.align || 'center' }}
                    >
                      Ref: EG-8A2B3C4D
                    </div>
                  );
                } else if (el.type === 'divider') {
                  content = (
                    <div
                      className="bg-black"
                      style={{ width: `${el.width || 344}px`, height: `${el.height || 1}px` }}
                    />
                  );
                } else if (el.type === 'rectangle') {
                  content = (
                    <div
                      className="border-2 border-black bg-transparent"
                      style={{ width: `${el.width || 344}px`, height: `${el.height || 60}px` }}
                    />
                  );
                } else {
                  content = (
                    <div
                      className="text-black"
                      style={{
                        fontSize: `${el.fontSize || 10}px`,
                        fontWeight: el.fontWeight || 'normal',
                        textAlign: el.align || 'center',
                      }}
                    >
                      {el.text || el.label || 'Notice'}
                    </div>
                  );
                }

                return (
                  <div
                    key={el.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedElementId(el.id);
                    }}
                    className={`absolute cursor-move transition-all ${
                      isSelected
                        ? 'ring-2 ring-blue-500 ring-offset-1 z-30'
                        : 'hover:ring-1 hover:ring-zinc-400 z-10'
                    }`}
                    style={{
                      left: `${el.x}px`,
                      top: `${el.y}px`,
                      transform: el.align === 'center' && el.fontSize ? 'translateX(-50%)' : undefined,
                    }}
                  >
                    {content}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
