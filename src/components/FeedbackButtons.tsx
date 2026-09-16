"use client";

import { useState } from "react";

type Side = "long" | "short";

interface Props {
  symbol: string;
  side: Side;
  score?: number | null;
  price?: number | null;
  compact?: boolean;
  onDone?: () => void;
}

/**
 * Optional ถูก / ผิด / ข้าม — posts to /api/feedback. Primary learning is auto price eval.
 */
export function FeedbackButtons({
  symbol,
  side,
  score,
  price,
  compact,
  onDone,
}: Props) {
  const [busy, setBusy] = useState<"win" | "loss" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function send(outcome: "win" | "loss") {
    setBusy(outcome);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          side,
          outcome,
          score: score ?? undefined,
          price: price ?? undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
      setMsg(outcome === "win" ? "บันทึก: ถูก" : "บันทึก: ผิด");
      onDone?.();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  function skip() {
    setMsg("ข้าม");
    setErr(null);
    onDone?.();
  }

  const btn =
    "rounded px-2 py-0.5 text-[10px] font-semibold transition-colors disabled:opacity-50";

  return (
    <div
      className={
        compact
          ? "mt-1 flex flex-wrap items-center gap-1"
          : "mt-2 flex flex-wrap items-center gap-1.5"
      }
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <span className="text-[9px] text-zinc-500">เรียนมือ:</span>
      <button
        type="button"
        disabled={!!busy}
        onClick={() => void send("win")}
        className={`${btn} border border-emerald-700 bg-emerald-950 text-emerald-300 hover:bg-emerald-900`}
      >
        {busy === "win" ? "…" : "ถูก"}
      </button>
      <button
        type="button"
        disabled={!!busy}
        onClick={() => void send("loss")}
        className={`${btn} border border-rose-700 bg-rose-950 text-rose-300 hover:bg-rose-900`}
      >
        {busy === "loss" ? "…" : "ผิด"}
      </button>
      <button
        type="button"
        disabled={!!busy}
        onClick={skip}
        className={`${btn} border border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800`}
      >
        ข้าม
      </button>
      {msg && <span className="text-[9px] text-sky-400">{msg}</span>}
      {err && <span className="text-[9px] text-rose-400">{err}</span>}
      <p className="basis-full text-[9px] leading-snug text-zinc-500">
        ไม่ต้องกดเอง — ระบบประเมินจากราคาอัตโนมัติทุก几นาที ปุ่มถูก/ผิดเป็นตัวเลือกเร่งเท่านั้น
      </p>
    </div>
  );
}
