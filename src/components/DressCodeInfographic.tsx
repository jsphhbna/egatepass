import { Check, Ban, AlertCircle, ShieldCheck } from 'lucide-react';
import { LANDING_CONTENT } from '../content/landing';

export function DressCodeInfographic() {
  const content = LANDING_CONTENT.dressCode;

  return (
    <div className="w-full mt-10 space-y-8" data-testid="dress-code-infographic">
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-stretch">
        {/* ========================================================
            COLUMN 1: ACCEPTABLE ATTIRE (PROPER CAMPUS ATTIRE)
            ======================================================== */}
        <div
          data-testid="acceptable-attire-section"
          className="rounded-3xl border-2 border-emerald-500/30 bg-white p-6 sm:p-8 shadow-sm flex flex-col justify-between"
        >
          <div>
            <div className="flex items-center justify-between pb-4 border-b border-emerald-100">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-100 text-emerald-800 flex-shrink-0">
                  <Check className="h-5 w-5 stroke-[2.5]" aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                    <span>Proper Campus Attire</span>
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                      Acceptable
                    </span>
                  </h3>
                  <p className="text-xs text-slate-600">
                    Standard visitor clothing permitted inside the EARIST campus
                  </p>
                </div>
              </div>
            </div>

            {/* Acceptable items list with dedicated clothing SVG illustrations */}
            <div className="mt-6 space-y-4">
              {/* Rule 1: T-shirt, polo shirt or collared blouse */}
              <div className="flex items-center gap-4 p-3.5 rounded-2xl border border-emerald-200 bg-emerald-50/60 transition-colors">
                <div className="relative w-14 h-14 bg-white rounded-xl border border-emerald-200 flex items-center justify-center flex-shrink-0 shadow-sm">
                  {/* Vector SVG: Collared Polo Shirt / T-Shirt in EARIST Maroon */}
                  <svg
                    viewBox="0 0 64 64"
                    fill="none"
                    className="w-10 h-10"
                    aria-label="T-shirt, polo shirt or collared blouse illustration"
                    role="img"
                  >
                    <path
                      d="M18 18 L24 14 L40 14 L46 18 L56 26 L50 34 L44 30 L44 54 L20 54 L20 30 L14 34 L8 26 Z"
                      fill="#7b1113"
                      stroke="#5a0b0d"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                    <path d="M24 14 L32 24 L27 25 L21 16 Z" fill="#93181a" stroke="#5a0b0d" strokeWidth="1" />
                    <path d="M40 14 L32 24 L37 25 L43 16 Z" fill="#93181a" stroke="#5a0b0d" strokeWidth="1" />
                    <line x1="32" y1="24" x2="32" y2="36" stroke="#5a0b0d" strokeWidth="1.5" />
                    <circle cx="32" cy="27" r="1" fill="#f8fafc" />
                    <circle cx="32" cy="32" r="1" fill="#f8fafc" />
                  </svg>
                  {/* Approval Badge */}
                  <div className="absolute -top-1 -right-1 bg-emerald-600 text-white rounded-full p-0.5 shadow-sm">
                    <Check className="h-3.5 w-3.5 stroke-[3]" />
                  </div>
                </div>
                <div>
                  <h5 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <span>T-shirt, polo shirt or collared blouse</span>
                    <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                      Permitted
                    </span>
                  </h5>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Standard crew-neck, collared polo shirt, or neat blouse with sleeves.
                  </p>
                </div>
              </div>

              {/* Rule 2: Full-length pants, trousers or long jeans */}
              <div className="flex items-center gap-4 p-3.5 rounded-2xl border border-emerald-200 bg-emerald-50/60 transition-colors">
                <div className="relative w-14 h-14 bg-white rounded-xl border border-emerald-200 flex items-center justify-center flex-shrink-0 shadow-sm">
                  {/* Vector SVG: Full-Length Pants / Trousers / Jeans */}
                  <svg
                    viewBox="0 0 64 64"
                    fill="none"
                    className="w-10 h-10"
                    aria-label="Full-length pants, trousers or long jeans illustration"
                    role="img"
                  >
                    <path
                      d="M18 12 L46 12 L48 54 L36 54 L32 28 L28 54 L16 54 Z"
                      fill="#1e293b"
                      stroke="#0f172a"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                    <rect x="18" y="12" width="28" height="5" fill="#0f172a" />
                    <line x1="24" y1="12" x2="24" y2="17" stroke="#334155" strokeWidth="1.5" />
                    <line x1="40" y1="12" x2="40" y2="17" stroke="#334155" strokeWidth="1.5" />
                    <path d="M18 19 Q25 21 27 17" stroke="#334155" strokeWidth="1" fill="none" />
                    <path d="M46 19 Q39 21 37 17" stroke="#334155" strokeWidth="1" fill="none" />
                  </svg>
                  {/* Approval Badge */}
                  <div className="absolute -top-1 -right-1 bg-emerald-600 text-white rounded-full p-0.5 shadow-sm">
                    <Check className="h-3.5 w-3.5 stroke-[3]" />
                  </div>
                </div>
                <div>
                  <h5 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <span>Full-length pants, trousers or long jeans</span>
                    <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                      Permitted
                    </span>
                  </h5>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Jeans, slacks, or trousers extending fully down to the ankles.
                  </p>
                </div>
              </div>

              {/* Rule 3: Closed shoes, sneakers or formal footwear */}
              <div className="flex items-center gap-4 p-3.5 rounded-2xl border border-emerald-200 bg-emerald-50/60 transition-colors">
                <div className="relative w-14 h-14 bg-white rounded-xl border border-emerald-200 flex items-center justify-center flex-shrink-0 shadow-sm">
                  {/* Vector SVG: Closed Footwear / Sneakers */}
                  <svg
                    viewBox="0 0 64 64"
                    fill="none"
                    className="w-10 h-10"
                    aria-label="Closed shoes, sneakers or formal footwear illustration"
                    role="img"
                  >
                    <path
                      d="M10 38 C10 32, 22 26, 26 28 L28 38 L30 42 C30 44, 8 44, 8 42 Z"
                      fill="#334155"
                      stroke="#1e293b"
                      strokeWidth="1.2"
                    />
                    <path d="M8 42 L30 42 L30 45 L8 45 Z" fill="#e2e8f0" stroke="#cbd5e1" strokeWidth="1" />
                    <line x1="20" y1="31" x2="25" y2="33" stroke="#f8fafc" strokeWidth="1.2" />
                    <line x1="19" y1="34" x2="24" y2="36" stroke="#f8fafc" strokeWidth="1.2" />
                    <path
                      d="M34 38 C34 32, 46 26, 50 28 L52 38 L56 42 C56 44, 32 44, 32 42 Z"
                      fill="#475569"
                      stroke="#1e293b"
                      strokeWidth="1.2"
                    />
                    <path d="M32 42 L56 42 L56 45 L32 45 Z" fill="#e2e8f0" stroke="#cbd5e1" strokeWidth="1" />
                    <line x1="44" y1="31" x2="49" y2="33" stroke="#f8fafc" strokeWidth="1.2" />
                    <line x1="43" y1="34" x2="48" y2="36" stroke="#f8fafc" strokeWidth="1.2" />
                  </svg>
                  {/* Approval Badge */}
                  <div className="absolute -top-1 -right-1 bg-emerald-600 text-white rounded-full p-0.5 shadow-sm">
                    <Check className="h-3.5 w-3.5 stroke-[3]" />
                  </div>
                </div>
                <div>
                  <h5 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <span>Closed shoes, sneakers or formal footwear</span>
                    <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                      Permitted
                    </span>
                  </h5>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Closed shoes, rubber sneakers, loafers, or formal leather footwear.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 pt-3 border-t border-emerald-100 flex items-center justify-between text-[11px] text-emerald-800 font-medium">
            <span>✓ Modest casual attire meets all EARIST campus entry standards.</span>
          </div>
        </div>

        {/* ========================================================
            COLUMN 2: NOT PERMITTED ATTIRE (PLEASE AVOID)
            ======================================================== */}
        <div
          data-testid="prohibited-attire-section"
          className="rounded-3xl border-2 border-red-500/30 bg-white p-6 sm:p-8 shadow-sm flex flex-col justify-between"
        >
          <div>
            <div className="flex items-center justify-between pb-4 border-b border-red-100">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-red-100 text-red-800 flex-shrink-0">
                  <Ban className="h-5 w-5 stroke-[2.5]" aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                    <span>Please Avoid</span>
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-800">
                      Not Permitted
                    </span>
                  </h3>
                  <p className="text-xs text-slate-600">
                    Prohibited attire will result in entry denial at the campus gate
                  </p>
                </div>
              </div>
            </div>

            {/* Prohibited items list with dedicated clothing SVG illustrations */}
            <div className="mt-6 space-y-4">
              {/* Prohibited 1: Shorts, including athletic and cycling shorts */}
              <div className="flex items-center gap-4 p-3.5 rounded-2xl border border-red-200 bg-red-50/60 transition-colors">
                <div className="relative w-14 h-14 bg-white rounded-xl border border-red-200 flex items-center justify-center flex-shrink-0 shadow-sm">
                  {/* Vector SVG: Shorts */}
                  <svg
                    viewBox="0 0 64 64"
                    fill="none"
                    className="w-10 h-10"
                    aria-label="Shorts, including athletic and cycling shorts illustration"
                    role="img"
                  >
                    <path
                      d="M16 16 L48 16 L44 42 L33 42 L32 26 L31 42 L20 42 Z"
                      fill="#94a3b8"
                      stroke="#64748b"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                    <line x1="16" y1="21" x2="48" y2="21" stroke="#475569" strokeWidth="1.5" />
                    <line x1="17" y1="23" x2="21" y2="42" stroke="#cbd5e1" strokeWidth="1.2" />
                    <line x1="47" y1="23" x2="43" y2="42" stroke="#cbd5e1" strokeWidth="1.2" />
                  </svg>
                  {/* Prohibition Badge */}
                  <div className="absolute -top-1 -right-1 bg-red-600 text-white rounded-full p-0.5 shadow-sm">
                    <Ban className="h-3.5 w-3.5 stroke-[3]" />
                  </div>
                </div>
                <div>
                  <h5 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <span>Shorts, including athletic and cycling shorts</span>
                    <span className="text-[10px] font-semibold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">
                      Prohibited
                    </span>
                  </h5>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Bermuda shorts, cycling shorts, board shorts, or any above-knee cut.
                  </p>
                </div>
              </div>

              {/* Prohibited 2: Sandals, slippers and open-toe rubber footwear */}
              <div className="flex items-center gap-4 p-3.5 rounded-2xl border border-red-200 bg-red-50/60 transition-colors">
                <div className="relative w-14 h-14 bg-white rounded-xl border border-red-200 flex items-center justify-center flex-shrink-0 shadow-sm">
                  {/* Vector SVG: Sandals / Slippers */}
                  <svg
                    viewBox="0 0 64 64"
                    fill="none"
                    className="w-10 h-10"
                    aria-label="Sandals, slippers and open-toe rubber footwear illustration"
                    role="img"
                  >
                    <path
                      d="M16 20 C16 14, 25 14, 25 20 L25 44 C25 48, 16 48, 16 44 Z"
                      fill="#e2e8f0"
                      stroke="#94a3b8"
                      strokeWidth="1.5"
                    />
                    <path d="M20.5 22 L17 32 M20.5 22 L24 32" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" />
                    <circle cx="20.5" cy="22" r="1.5" fill="#dc2626" />
                    <path
                      d="M39 20 C39 14, 48 14, 48 20 L48 44 C48 48, 39 48, 39 44 Z"
                      fill="#e2e8f0"
                      stroke="#94a3b8"
                      strokeWidth="1.5"
                    />
                    <path d="M43.5 22 L40 32 M43.5 22 L47 32" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" />
                    <circle cx="43.5" cy="22" r="1.5" fill="#dc2626" />
                  </svg>
                  {/* Prohibition Badge */}
                  <div className="absolute -top-1 -right-1 bg-red-600 text-white rounded-full p-0.5 shadow-sm">
                    <Ban className="h-3.5 w-3.5 stroke-[3]" />
                  </div>
                </div>
                <div>
                  <h5 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <span>Sandals, slippers and open-toe rubber footwear</span>
                    <span className="text-[10px] font-semibold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">
                      Prohibited
                    </span>
                  </h5>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Open sandals, slippers, flip-flops, crocs in sports mode, or slides.
                  </p>
                </div>
              </div>

              {/* Prohibited 3: Sleeveless tops, sando, tank tops and spaghetti straps */}
              <div className="flex items-center gap-4 p-3.5 rounded-2xl border border-red-200 bg-red-50/60 transition-colors">
                <div className="relative w-14 h-14 bg-white rounded-xl border border-red-200 flex items-center justify-center flex-shrink-0 shadow-sm">
                  {/* Vector SVG: Sleeveless Top / Sando / Tank Top */}
                  <svg
                    viewBox="0 0 64 64"
                    fill="none"
                    className="w-10 h-10"
                    aria-label="Sleeveless tops, sando, tank tops and spaghetti straps illustration"
                    role="img"
                  >
                    <path
                      d="M21 16 L27 16 L28 26 L36 26 L37 16 L43 16 L46 48 L18 48 Z"
                      fill="#cbd5e1"
                      stroke="#64748b"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                    <path d="M27 16 C29 22, 35 22, 37 16" stroke="#64748b" strokeWidth="1.5" fill="none" />
                    <path d="M21 16 C19 28, 20 34, 18 48" stroke="#94a3b8" strokeWidth="1" strokeDasharray="2 2" />
                    <path d="M43 16 C45 28, 44 34, 46 48" stroke="#94a3b8" strokeWidth="1" strokeDasharray="2 2" />
                  </svg>
                  {/* Prohibition Badge */}
                  <div className="absolute -top-1 -right-1 bg-red-600 text-white rounded-full p-0.5 shadow-sm">
                    <Ban className="h-3.5 w-3.5 stroke-[3]" />
                  </div>
                </div>
                <div>
                  <h5 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <span>Sleeveless tops, sando, tank tops and spaghetti straps</span>
                    <span className="text-[10px] font-semibold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">
                      Prohibited
                    </span>
                  </h5>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Sleeveless shirts, sando, tank tops, muscle shirts, or spaghetti straps.
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
