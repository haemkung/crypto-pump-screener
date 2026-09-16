import { proxyGet, SPOT_HOSTS } from "@/lib/proxyFetch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return proxyGet("/api/v3/ticker/24hr", SPOT_HOSTS);
}
