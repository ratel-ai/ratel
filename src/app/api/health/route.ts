import { getRuntime } from "@/lib/composition/runtime";

export async function GET() {
  const runtime = await getRuntime();
  return Response.json({ status: "ok", edition: runtime.edition });
}
