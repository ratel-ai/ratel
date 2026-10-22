import { getRuntime } from "@/lib/runtime";

export async function GET() {
  const runtime = await getRuntime();
  return Response.json({ status: "ok", edition: runtime.edition });
}
