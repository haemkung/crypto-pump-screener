"use client";

import { LearningStatsPanel } from "./LearningStatsPanel";
import { CoachNotesPanel } from "./CoachNotesPanel";
import { EarlyTiersPanel } from "./EarlyTiersPanel";

/**
 * Light UI shell: early tiers + learning + coach only.
 * Heavy /api/screen table + filters removed — less client work, faster paint.
 * Server screening scripts / Telegram early daemon stay untouched.
 */
export function Screener() {
  return (
    <div className="mx-auto min-h-[100dvh] max-w-[1600px] bg-[#09090b] px-4 py-6 text-[#fafafa]">
      <header className="mb-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="mb-1 text-xs uppercase tracking-widest text-emerald-500/80">
              Binance USDⓈ-M Futures
            </p>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">
              Crypto Pump / Dump Pattern Screener
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              เฝ้าดูระยะต้น (กำลังสะสม / แจกของ / เริ่มขยับ / ทุบ) — heuristic จากข้อมูลสาธารณะ
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200/90">
          <strong>คำเตือน / Disclaimer:</strong> ไม่ใช่คำแนะนำการลงทุนหรือการเงิน
          (Not financial advice). สัญญาณระยะต้นเป็น heuristic จากข้อมูลสาธารณะของ Binance
          เท่านั้น อาจผิดพลาด / ล่าช้า — ใช้ศึกษาและคัดกรองเบื้องต้นเท่านั้น ความเสี่ยงสูง
        </div>

        {/* Early tiers (confluence-first) — primary playable signals */}
        <EarlyTiersPanel />

        {/* Optional panels — failures should not blank the page */}
        <div className="contents">
          <LearningStatsPanel />
          <CoachNotesPanel />
        </div>
      </header>

      <footer className="mt-8 border-t border-zinc-900 pt-4 text-center text-[11px] text-zinc-600">
        Early tiers · learning stats · coach notes · ไม่ invent ตัวเลขที่ API ไม่ให้ ·
        ข้อมูลจาก Binance public API
      </footer>
    </div>
  );
}
