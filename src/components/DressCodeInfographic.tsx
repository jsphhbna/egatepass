import { Check, Ban, AlertCircle, ShieldCheck } from 'lucide-react';
import { LANDING_CONTENT } from '../content/landing';

export function DressCodeInfographic() {
  const content = LANDING_CONTENT.dressCode;

  return (
    <div className="w-full mt-10 space-y-8">
      {/* Policy summary header banner with EARIST maroon branding */}
      <div className="rounded-2xl border border-red-200/80 bg-gradient-to-r from-[#7b1113]/5 via-red-50/40 to-slate-50 p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#7b1113] text-white shadow-sm flex-shrink-0">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h4 className="text-sm sm:text-base font-bold text-slate-900">
              Institutional Gate Attire Standards
            </h4>
            <p className="text-xs text-slate-600">
              EARIST entry policy requires all visitors to wear decent, standard attire.
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold bg-[#7b1113]/10 text-[#7b1113] border border-[#7b1113]/20">
          Official EARIST Policy
        </span>
      </div>

      {/* Main visual side-by-side infographic grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        {/* ========================================================
            COLUMN 1: ACCEPTABLE ATTIRE (FULL-BODY VISITOR ILLUSTRATION)
            ======================================================== */}
        <div className="lg:col-span-7 rounded-3xl border-2 border-emerald-500/30 bg-white p-6 sm:p-8 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-4 border-b border-emerald-100">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-100 text-emerald-800">
                  <Check className="h-5 w-5 stroke-[2.5]" aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                    Acceptable Attire
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                      Permitted
                    </span>
                  </h3>
                  <p className="text-xs text-slate-600">
                    Standard visitor clothing allowed inside the campus
                  </p>
                </div>
              </div>
            </div>

            {/* Visual full-body illustration and callout badges */}
            <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-6 sm:gap-8">
              {/* Full-Body Vector SVG Visitor Illustration */}
              <div className="relative w-44 sm:w-52 h-80 flex-shrink-0 flex items-center justify-center bg-slate-50 rounded-2xl border border-slate-100 p-2 shadow-inner">
                <svg
                  viewBox="0 0 160 300"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-full h-full max-h-72 drop-shadow-sm"
                  aria-label="Full-body illustrated visitor wearing acceptable attire: T-shirt, full-length pants, and shoes"
                  role="img"
                >
                  {/* Head & Hair */}
                  <ellipse cx="80" cy="38" rx="16" ry="20" fill="#fbd5b5" />
                  <path
                    d="M62 34 C62 18, 98 18, 98 34 C94 25, 68 25, 64 34 Z"
                    fill="#334155"
                  />
                  {/* Neck */}
                  <rect x="75" y="55" width="10" height="9" fill="#fbd5b5" />

                  {/* ITEM 1: T-Shirt (EARIST maroon brand accent) */}
                  <g id="visitor-tshirt">
                    {/* Torso & short sleeves */}
                    <path
                      d="M56 64 L72 61 L80 66 L88 61 L104 64 L114 90 L98 94 L98 140 L62 140 L62 94 L46 90 Z"
                      fill="#7b1113"
                    />
                    {/* Collar neckline */}
                    <path
                      d="M72 61 C76 68, 84 68, 88 61"
                      stroke="#fbd5b5"
                      strokeWidth="2.5"
                      fill="none"
                    />
                    {/* Small visitor badge on chest */}
                    <rect x="68" y="76" width="10" height="8" rx="1.5" fill="#f8fafc" opacity="0.9" />
                    <rect x="71" y="74" width="4" height="2" fill="#cbd5e1" />
                  </g>

                  {/* Hands */}
                  <ellipse cx="43" cy="100" rx="5" ry="7" fill="#fbd5b5" />
                  <ellipse cx="117" cy="100" rx="5" ry="7" fill="#fbd5b5" />

                  {/* ITEM 2: Full-length pants / trousers */}
                  <g id="visitor-pants">
                    <path
                      d="M62 140 L98 140 L100 248 L84 248 L80 174 L76 248 L60 248 Z"
                      fill="#1e293b"
                    />
                    {/* Belt / Waistband */}
                    <rect x="62" y="138" width="36" height="5" fill="#0f172a" />
                  </g>

                  {/* ITEM 3: Shoes (Closed footwear) */}
                  <g id="visitor-shoes">
                    {/* Left shoe */}
                    <path
                      d="M58 248 L76 248 L76 258 C76 261, 52 261, 52 258 L54 251 Z"
                      fill="#475569"
                    />
                    <path d="M52 258 L76 258 L76 261 L52 261 Z" fill="#e2e8f0" />

                    {/* Right shoe */}
                    <path
                      d="M84 248 L102 248 L104 251 L106 258 C106 261, 82 261, 82 258 L84 258 Z"
                      fill="#475569"
                    />
                    <path d="M82 258 L106 258 L106 261 L82 261 Z" fill="#e2e8f0" />
                  </g>
                </svg>
              </div>

              {/* Acceptable Items Detailed Checklist */}
              <div className="flex-1 w-full space-y-3.5">
                {/* Rule 1: T-shirt */}
                <div className="flex items-start gap-3 p-3 rounded-2xl border border-emerald-200 bg-emerald-50/60">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-600 text-white flex-shrink-0 mt-0.5">
                    <Check className="h-4 w-4 stroke-[2.5]" aria-hidden="true" />
                  </div>
                  <div>
                    <h5 className="text-sm font-bold text-slate-900">T-Shirt</h5>
                    <p className="text-xs text-slate-600">
                      Standard crew-neck, polo shirt, or casual t-shirt with sleeves.
                    </p>
                  </div>
                </div>

                {/* Rule 2: Full-length pants */}
                <div className="flex items-start gap-3 p-3 rounded-2xl border border-emerald-200 bg-emerald-50/60">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-600 text-white flex-shrink-0 mt-0.5">
                    <Check className="h-4 w-4 stroke-[2.5]" aria-hidden="true" />
                  </div>
                  <div>
                    <h5 className="text-sm font-bold text-slate-900">Full-Length Pants or Trousers</h5>
                    <p className="text-xs text-slate-600">
                      Jeans, slacks, or trousers extending fully down to the ankles.
                    </p>
                  </div>
                </div>

                {/* Rule 3: Shoes */}
                <div className="flex items-start gap-3 p-3 rounded-2xl border border-emerald-200 bg-emerald-50/60">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-600 text-white flex-shrink-0 mt-0.5">
                    <Check className="h-4 w-4 stroke-[2.5]" aria-hidden="true" />
                  </div>
                  <div>
                    <h5 className="text-sm font-bold text-slate-900">Shoes</h5>
                    <p className="text-xs text-slate-600">
                      Closed footwear such as rubber sneakers, leather shoes, or loafers.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 pt-3 border-t border-emerald-100 flex items-center justify-between text-[11px] text-emerald-800 font-medium">
            <span>✓ Complete modest casual attire meets EARIST campus entry standards.</span>
          </div>
        </div>

        {/* ========================================================
            COLUMN 2: NOT PERMITTED ATTIRE (PROHIBITED ITEMS)
            ======================================================== */}
        <div className="lg:col-span-5 rounded-3xl border-2 border-red-500/30 bg-white p-6 sm:p-8 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-4 border-b border-red-100">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-red-100 text-red-800">
                  <Ban className="h-5 w-5 stroke-[2.5]" aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                    Not Permitted
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-800">
                      Prohibited
                    </span>
                  </h3>
                  <p className="text-xs text-slate-600">
                    Entry will be politely denied at campus gates
                  </p>
                </div>
              </div>
            </div>

            {/* Grid of Prohibited Attire Illustrations */}
            <div className="mt-6 space-y-3.5">
              {/* Prohibited Item 1: Shorts */}
              <div className="flex items-center gap-4 p-3 rounded-2xl border border-red-200 bg-red-50/60">
                <div className="relative w-14 h-14 bg-white rounded-xl border border-red-200 flex items-center justify-center flex-shrink-0 shadow-sm">
                  {/* Vector SVG Shorts */}
                  <svg viewBox="0 0 48 48" fill="none" className="w-10 h-10" aria-hidden="true">
                    <path
                      d="M10 12 L38 12 L35 32 L26 32 L24 20 L22 32 L13 32 Z"
                      fill="#94a3b8"
                      stroke="#64748b"
                      strokeWidth="1.5"
                    />
                    <line x1="10" y1="16" x2="38" y2="16" stroke="#475569" strokeWidth="1.5" />
                  </svg>
                  {/* Prohibition Badge */}
                  <div className="absolute -top-1 -right-1 bg-red-600 text-white rounded-full p-0.5 shadow-sm">
                    <Ban className="h-3.5 w-3.5 stroke-[3]" />
                  </div>
                </div>
                <div>
                  <h5 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <span>Shorts</span>
                    <span className="text-[10px] font-semibold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">
                      Prohibited
                    </span>
                  </h5>
                  <p className="text-xs text-slate-600">
                    Bermuda shorts, cycling shorts, board shorts, or any above-knee cut.
                  </p>
                </div>
              </div>

              {/* Prohibited Item 2: Sandals */}
              <div className="flex items-center gap-4 p-3 rounded-2xl border border-red-200 bg-red-50/60">
                <div className="relative w-14 h-14 bg-white rounded-xl border border-red-200 flex items-center justify-center flex-shrink-0 shadow-sm">
                  {/* Vector SVG Sandals / Slippers */}
                  <svg viewBox="0 0 48 48" fill="none" className="w-10 h-10" aria-hidden="true">
                    {/* Sole */}
                    <path
                      d="M14 16 C14 12, 22 12, 22 16 L22 34 C22 38, 14 38, 14 34 Z"
                      fill="#cbd5e1"
                      stroke="#94a3b8"
                      strokeWidth="1.5"
                    />
                    {/* Straps / Thong */}
                    <path d="M18 16 L15 24 M18 16 L21 24" stroke="#e11d48" strokeWidth="2" strokeLinecap="round" />
                    <circle cx="18" cy="16" r="1.5" fill="#e11d48" />

                    {/* Second Slipper */}
                    <path
                      d="M26 16 C26 12, 34 12, 34 16 L34 34 C34 38, 26 38, 26 34 Z"
                      fill="#cbd5e1"
                      stroke="#94a3b8"
                      strokeWidth="1.5"
                    />
                    <path d="M30 16 L27 24 M30 16 L33 24" stroke="#e11d48" strokeWidth="2" strokeLinecap="round" />
                    <circle cx="30" cy="16" r="1.5" fill="#e11d48" />
                  </svg>
                  {/* Prohibition Badge */}
                  <div className="absolute -top-1 -right-1 bg-red-600 text-white rounded-full p-0.5 shadow-sm">
                    <Ban className="h-3.5 w-3.5 stroke-[3]" />
                  </div>
                </div>
                <div>
                  <h5 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <span>Sandals</span>
                    <span className="text-[10px] font-semibold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">
                      Prohibited
                    </span>
                  </h5>
                  <p className="text-xs text-slate-600">
                    Open sandals, slippers, flip-flops, crocs in sports mode, or slides.
                  </p>
                </div>
              </div>

              {/* Prohibited Item 3: Sleeveless Tops / Sando */}
              <div className="flex items-center gap-4 p-3 rounded-2xl border border-red-200 bg-red-50/60">
                <div className="relative w-14 h-14 bg-white rounded-xl border border-red-200 flex items-center justify-center flex-shrink-0 shadow-sm">
                  {/* Vector SVG Sleeveless Sando */}
                  <svg viewBox="0 0 48 48" fill="none" className="w-10 h-10" aria-hidden="true">
                    <path
                      d="M16 12 L20 12 L21 20 L27 20 L28 12 L32 12 L34 36 L14 36 Z"
                      fill="#cbd5e1"
                      stroke="#64748b"
                      strokeWidth="1.5"
                    />
                    <path d="M20 12 C22 17, 26 17, 28 12" stroke="#64748b" strokeWidth="1.5" fill="none" />
                  </svg>
                  {/* Prohibition Badge */}
                  <div className="absolute -top-1 -right-1 bg-red-600 text-white rounded-full p-0.5 shadow-sm">
                    <Ban className="h-3.5 w-3.5 stroke-[3]" />
                  </div>
                </div>
                <div>
                  <h5 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <span>Sleeveless Tops / Sando</span>
                    <span className="text-[10px] font-semibold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">
                      Prohibited
                    </span>
                  </h5>
                  <p className="text-xs text-slate-600">
                    Sleeveless shirts, tank tops, muscle shirts, or sando are not allowed.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 pt-3 border-t border-red-100 flex items-center gap-1.5 text-[11px] text-red-800">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>Visitors wearing prohibited attire will be requested to change before entry.</span>
          </div>
        </div>
      </div>

      {/* Institutional note footer */}
      <div className="text-center text-xs text-slate-500 pt-2">
        <p>{content.note}</p>
      </div>
    </div>
  );
}
