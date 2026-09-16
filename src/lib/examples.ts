/** Historical example cards — labeled as past cases, not live signals. */

export interface ExampleCase {
  id: string;
  titleTh: string;
  titleEn: string;
  symbolHint: string;
  summaryTh: string;
  tags: string[];
}

export const EXAMPLE_CASES: ExampleCase[] = [
  {
    id: "ake",
    titleTh: "AKE",
    titleEn: "AKE",
    symbolHint: "AKEUSDT",
    summaryTh:
      "เคสในอดีต: มี catalyst + วอลุ่มฟิวเจอร์สพุ่ง + funding ติดลบ แล้วเกิด short squeeze — ใช้เป็นตัวอย่างรูปแบบเท่านั้น",
    tags: ["catalyst", "volume", "funding−", "squeeze"],
  },
  {
    id: "lsk",
    titleTh: "LSK",
    titleEn: "LSK",
    symbolHint: "LSKUSDT",
    summaryTh:
      "เคสในอดีต: narrative / partnership ทำให้สภาพคล่องบาง + OI เพิ่มขึ้นเร็ว — ไม่ใช่คำแนะนำปัจจุบัน",
    tags: ["narrative", "OI↑", "thin liq"],
  },
  {
    id: "btw",
    titleTh: "BTW",
    titleEn: "BTW",
    symbolHint: "BTWUSDT",
    summaryTh:
      "เคสในอดีต: อัตราส่วน futures/spot สูง (สภาพคล่องบาง) ร่วมกับวอลุ่มหนัก — ระวัง chase หลังขึ้นไปแล้ว",
    tags: ["fut/spot↑", "volume", "late risk"],
  },
  {
    id: "useless",
    titleTh: "USELESS",
    titleEn: "USELESS",
    symbolHint: "USELESSUSDT",
    summaryTh:
      "เคสในอดีต: meme / social catalyst + short fuel — รูปแบบคล้ายกันอาจเกิดซ้ำได้ แต่ผลลัพธ์ไม่การันตี",
    tags: ["meme", "catalyst", "funding−"],
  },
  {
    id: "lobster",
    titleTh: "龙虾 (Lobster)",
    titleEn: "Lobster / 龙虾",
    symbolHint: "LOBSTERUSDT",
    summaryTh:
      "เคสในอดีต: meme ภาษาจีน (龙虾) ที่วอลุ่มและ narrative ผลักดัน — ใช้ศึกษา pattern เท่านั้น",
    tags: ["meme", "CN narrative", "volume"],
  },
];
