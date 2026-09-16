import { proxyGet, FAPI_HOSTS } from "@/lib/proxyFetch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return proxyGet("/fapi/v1/premiumIndex", FAPI_HOSTS);
}
