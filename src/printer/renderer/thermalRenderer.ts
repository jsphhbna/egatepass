import QRCode from 'qrcode';
import type { PassPresentation } from '@/lib/passPresentation';
import type { ThermalTemplateLayout, ThermalTemplateElement } from '@/types/thermalTemplate';
import { BUNDLED_DEFAULT_THERMAL_TEMPLATE } from '../templates/bundledDefaultTemplate';
import { splitGraphemes } from '@/lib/textGraphemes';

export interface RenderThermalResult {
  canvas: HTMLCanvasElement;
  imageData: ImageData;
  dataUrl: string;
}

/**
 * Renders a crisp monochrome 384px-wide canvas for MXW01 thermal printing.
 * Never embeds photographic logos or multi-tone gradients that could degrade thermal scanning.
 */
export async function renderThermalPass(
  presentation: PassPresentation,
  layout: ThermalTemplateLayout = BUNDLED_DEFAULT_THERMAL_TEMPLATE
): Promise<RenderThermalResult> {
  const width = layout.width;
  const height = layout.height;

  if (typeof document === 'undefined') {
    throw new Error('Canvas rendering requires a browser or DOM environment');
  }

  if ((document as any).fonts?.load) {
    try {
      await (document as any).fonts.load('400 14px "Egatepass Noto Sans"');
      await (document as any).fonts.load('700 14px "Egatepass Noto Sans"');
    } catch (err) {
      console.warn('[thermalRenderer] Font Loading API rejected; proceeding with CSS fallback stack:', err);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to acquire 2D canvas context');

  // 1. Pure White Background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // 2. Pre-generate monochrome QR code
  const qrCanvas = document.createElement('canvas');
  await QRCode.toCanvas(qrCanvas, presentation.qrToken, {
    width: 260,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  });

  // 3. Render Elements according to Layout
  for (const el of layout.elements) {
    renderElement(ctx, el, presentation, qrCanvas);
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/png');

  return { canvas, imageData, dataUrl };
}

function renderElement(
  ctx: CanvasRenderingContext2D,
  el: ThermalTemplateElement,
  presentation: PassPresentation,
  qrCanvas: HTMLCanvasElement
) {
  if (el.type === 'divider') {
    ctx.fillStyle = '#000000';
    ctx.fillRect(el.x, el.y, el.width, Math.max(1, el.height));
    return;
  }

  if (el.type === 'rectangle') {
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(1, Math.min(el.height, 4));
    ctx.strokeRect(el.x, el.y, el.width, el.height);
    return;
  }

  if (el.type === 'qr') {
    // Draw pre-rendered crisp QR code scaled to element bounds
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(qrCanvas, el.x, el.y, el.width, el.height);
    return;
  }

  if (el.type === 'text') {
    let text = el.text || '';
    if (el.field === 'institution_name') {
      text = presentation.institutionName;
    } else if (el.field === 'system_title') {
      text = el.text || 'CAMPUS VISITOR PASS';
    } else if (el.field === 'visitor_name') {
      text = presentation.visitorName;
    } else if (el.field === 'visit_date') {
      text = `Visit Date: ${presentation.visitDate}`;
    } else if (el.field === 'pass_reference') {
      text = `Ref: ${presentation.passReference}`;
    } else if (el.field === 'validity_window') {
      text = presentation.validityWindow ? `Valid: ${presentation.validityWindow}` : '';
    } else if (el.field === 'purpose') {
      text = presentation.purpose ? `Purpose: ${presentation.purpose}` : '';
    }

    if (!text.trim()) return;

    const hasClipping = typeof ctx.save === 'function' && typeof ctx.clip === 'function';
    if (hasClipping) {
      ctx.save();
      // Clip strictly to element bounding box so text never renders outside bounds or over QR
      ctx.beginPath();
      ctx.rect(el.x, el.y, el.width, el.height);
      ctx.clip();
    }

    ctx.fillStyle = '#000000';
    const weight = el.fontWeight === 'bold' ? 'bold ' : '';
    const size = el.fontSize ?? 14;
    ctx.font = `${weight}${size}px "Egatepass Noto Sans", "Noto Sans", Arial, sans-serif`;

    const maxWidth = el.width;
    const lineHeight = Math.max(size * 1.2, 14);
    const maxLines = Math.max(1, Math.floor(el.height / lineHeight));

    // Word wrap & ellipsis within element bounds
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if (!word) continue;
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);
      if (metrics.width <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          // Word itself exceeds maxWidth: truncate with ellipsis (grapheme-safe)
          const g = splitGraphemes(word);
          while (g.length > 1 && ctx.measureText(g.join('') + '…').width > maxWidth) {
            g.pop();
          }
          lines.push(g.join('') + '…');
          currentLine = '';
        }
        if (lines.length >= maxLines) break;
      }
    }

    if (currentLine && lines.length < maxLines) {
      lines.push(currentLine);
    } else if (lines.length > 0 && lines.length >= maxLines && currentLine) {
      const lastIndex = lines.length - 1;
      const last = lines[lastIndex] ?? '';
      const rawText = last.endsWith('…') ? last.slice(0, -1) : last;
      const g = splitGraphemes(rawText);
      while (g.length > 1 && ctx.measureText(g.join('') + '…').width > maxWidth) {
        g.pop();
      }
      lines[lastIndex] = g.join('') + '…';
    }

    let textX = el.x;
    if (el.align === 'center') {
      ctx.textAlign = 'center';
      textX = el.x + el.width / 2;
    } else if (el.align === 'right') {
      ctx.textAlign = 'right';
      textX = el.x + el.width;
    } else {
      ctx.textAlign = 'left';
    }

    const totalTextHeight = lines.length * lineHeight;
    const startY = el.y + Math.max(0, (el.height - totalTextHeight) / 2) + lineHeight / 2;

    ctx.textBaseline = 'middle';
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (lineText) {
        ctx.fillText(lineText, textX, startY + i * lineHeight);
      }
    }
    if (hasClipping && typeof ctx.restore === 'function') {
      ctx.restore();
    }
  }
}

/**
 * Generates an official MXW01 Hardware Test Ticket (Phase 2.3 & Phase 20).
 */
export async function renderTestTicket(
  deviceName: string = 'MXW01 Thermal'
): Promise<RenderThermalResult> {
  const width = 384;
  const height = 480;

  if (typeof document === 'undefined') {
    throw new Error('Canvas rendering requires a browser environment');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to acquire 2D context');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Title
  ctx.font = 'bold 22px Arial, sans-serif';
  ctx.fillText('EARIST E-GATEPASS', width / 2, 35);

  ctx.font = 'bold 14px Arial, sans-serif';
  ctx.fillText('MXW01 PRINTER TEST OK', width / 2, 65);

  // Divider
  ctx.fillRect(16, 85, width - 32, 3);

  // Telemetry details
  ctx.font = '12px "Courier New", monospace';
  const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' });
  ctx.fillText(`Date: ${now}`, width / 2, 115);
  ctx.fillText(`Device: ${deviceName}`, width / 2, 135);
  ctx.fillText('Resolution: 384 dots (8 dots/mm)', width / 2, 155);

  // Test QR
  const qrCanvas = document.createElement('canvas');
  await QRCode.toCanvas(qrCanvas, 'EARIST_MXW01_TEST_OK', {
    width: 180,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' },
  });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qrCanvas, (width - 180) / 2, 180, 180, 180);

  // Footer
  ctx.fillRect(16, 385, width - 32, 2);
  ctx.font = 'bold 12px Arial, sans-serif';
  ctx.fillText('✓ HARDWARE INTEGRATION VERIFIED', width / 2, 410);
  ctx.font = '10px Arial, sans-serif';
  ctx.fillText('E-GatePass Kiosk Direct Bluetooth Print', width / 2, 430);

  const imageData = ctx.getImageData(0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/png');
  return { canvas, imageData, dataUrl };
}
