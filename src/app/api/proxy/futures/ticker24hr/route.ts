import { proxyGet, FAPI_HOSTS } from "@/lib/proxyFetch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return proxyGet("/fapi/v1/ticker/24hr", FAPI_HOSTS);
}
